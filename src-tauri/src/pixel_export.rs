use std::{
    env, fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

const PIXEL_AI_SCRIPT: &str = include_str!("../../scripts/pixel_perfect_ai.py");

fn validate_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 || width > 16_384 || height > 16_384 {
        return Err("Export dimensions must be between 1 and 16384 pixels.".into());
    }
    Ok(())
}

fn validate_png_path(path: &Path) -> Result<(), String> {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        != Some("png".into())
    {
        return Err("The export path must use the .png extension.".into());
    }
    Ok(())
}

fn render_svg(
    svg: &str,
    width: u32,
    height: u32,
    anti_alias: u8,
    resize_mode: &str,
) -> Result<tiny_skia::Pixmap, String> {
    validate_dimensions(width, height)?;
    let options = resvg::usvg::Options::default();
    let tree = resvg::usvg::Tree::from_data(svg.as_bytes(), &options)
        .map_err(|error| format!("Unable to parse the posed SVG: {error}"))?;
    let source_size = tree.size();
    let mut pixmap = tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| "Unable to allocate the export bitmap.".to_string())?;
    let scale_x = width as f32 / source_size.width();
    let scale_y = height as f32 / source_size.height();
    let transform = match resize_mode {
        "contain" => {
            let scale = scale_x.min(scale_y);
            let translate_x = (width as f32 - source_size.width() * scale) / 2.0;
            let translate_y = (height as f32 - source_size.height() * scale) / 2.0;
            tiny_skia::Transform::from_row(scale, 0.0, 0.0, scale, translate_x, translate_y)
        }
        "stretch" => tiny_skia::Transform::from_scale(scale_x, scale_y),
        _ => return Err("Resize mode must be contain or stretch.".into()),
    };
    resvg::render(&tree, transform, &mut pixmap.as_mut());

    let edge_strength = anti_alias.min(100) as f32 / 100.0;
    if edge_strength < 1.0 {
        for pixel in pixmap.data_mut().chunks_exact_mut(4) {
            let old_alpha = pixel[3];
            let hard_alpha = if old_alpha >= 128 { 255 } else { 0 };
            let new_alpha = ((hard_alpha as f32 * (1.0 - edge_strength))
                + (old_alpha as f32 * edge_strength))
                .round() as u8;
            if old_alpha == 0 || new_alpha == 0 {
                pixel.fill(0);
                continue;
            }
            for channel in &mut pixel[..3] {
                let straight = (*channel as u16 * 255 + old_alpha as u16 / 2) / old_alpha as u16;
                *channel = ((straight * new_alpha as u16 + 127) / 255).min(255) as u8;
            }
            pixel[3] = new_alpha;
        }
    }
    Ok(pixmap)
}

fn temporary_paths() -> (PathBuf, PathBuf, PathBuf) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let stem = format!("asset-studio-ai-{}-{stamp}", std::process::id());
    let directory = env::temp_dir();
    (
        directory.join(format!("{stem}.py")),
        directory.join(format!("{stem}-input.png")),
        directory.join(format!("{stem}-output.png")),
    )
}

fn run_python(program: &str, prefix: &[&str], script: &Path, input: &Path, output: &Path, palette_size: u8) -> Result<bool, String> {
    let result = Command::new(program)
        .args(prefix)
        .arg(script)
        .arg("--input")
        .arg(input)
        .arg("--output")
        .arg(output)
        .arg("--palette")
        .arg(palette_size.clamp(2, 64).to_string())
        .output();
    match result {
        Ok(process) if process.status.success() => Ok(true),
        Ok(process) => {
            let detail = String::from_utf8_lossy(&process.stderr).trim().to_string();
            Err(if detail.is_empty() {
                "The offline pixel model failed without an error message.".into()
            } else {
                format!("Offline pixel model failed: {detail}")
            })
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Unable to start the offline pixel model: {error}")),
    }
}

fn refine_png_bytes(png: &[u8], palette_size: u8) -> Result<Vec<u8>, String> {
    let (script, input, output) = temporary_paths();
    fs::write(&script, PIXEL_AI_SCRIPT).map_err(|error| format!("Unable to prepare the local AI script: {error}"))?;
    fs::write(&input, png).map_err(|error| format!("Unable to prepare the AI input: {error}"))?;

    let configured = env::var("ASSET_STUDIO_PYTHON").ok();
    let mut attempts: Vec<(&str, Vec<&str>)> = Vec::new();
    if let Some(ref path) = configured {
        attempts.push((path.as_str(), vec![]));
    }
    if cfg!(windows) {
        attempts.push((r"D:\Env\asset-studio\python\Scripts\python.exe", vec![]));
        attempts.push(("py", vec!["-3"]));
    }
    attempts.push(("python3", vec![]));
    attempts.push(("python", vec![]));

    let result = (|| {
        for (program, prefix) in attempts {
            if run_python(program, &prefix, &script, &input, &output, palette_size)? {
                return fs::read(&output).map_err(|error| format!("Unable to read the AI-refined PNG: {error}"));
            }
        }
        Err("Offline AI requires Python 3 with NumPy and Pillow. Run scripts/setup-pixel-ai.ps1 once, or set ASSET_STUDIO_PYTHON.".into())
    })();

    let _ = fs::remove_file(script);
    let _ = fs::remove_file(input);
    let _ = fs::remove_file(output);
    result
}

fn encode_output(pixmap: &tiny_skia::Pixmap, ai_filter: bool, ai_palette_size: u8) -> Result<Vec<u8>, String> {
    let png = pixmap
        .encode_png()
        .map_err(|error| format!("Unable to encode the PNG: {error}"))?;
    if ai_filter { refine_png_bytes(&png, ai_palette_size) } else { Ok(png) }
}

#[tauri::command]
pub(crate) fn refine_pixel_png(png: Vec<u8>, palette_size: u8) -> Result<Vec<u8>, String> {
    refine_png_bytes(&png, palette_size)
}

#[tauri::command]
pub(crate) fn export_png(
    svg: String,
    path: String,
    width: u32,
    height: u32,
    anti_alias: u8,
    resize_mode: String,
    ai_filter: bool,
    ai_palette_size: u8,
) -> Result<(), String> {
    let target = Path::new(&path);
    validate_png_path(target)?;
    let pixmap = render_svg(&svg, width, height, anti_alias, &resize_mode)?;
    let png = encode_output(&pixmap, ai_filter, ai_palette_size)?;
    fs::write(target, png).map_err(|error| format!("Unable to write the PNG: {error}"))
}

#[tauri::command]
pub(crate) fn export_tileset(
    svgs: Vec<String>,
    path: String,
    width: u32,
    height: u32,
    anti_alias: u8,
    resize_mode: String,
    ai_filter: bool,
    ai_palette_size: u8,
) -> Result<(), String> {
    if svgs.is_empty() {
        return Err("The tileset needs at least one frame.".into());
    }
    validate_dimensions(width, height)?;
    let sheet_width = width
        .checked_mul(svgs.len() as u32)
        .filter(|value| *value <= 16_384)
        .ok_or_else(|| "The horizontal tileset would exceed 16384 pixels. Reduce frame width or pose count.".to_string())?;
    let target = Path::new(&path);
    validate_png_path(target)?;
    let mut sheet = tiny_skia::Pixmap::new(sheet_width, height)
        .ok_or_else(|| "Unable to allocate the tileset bitmap.".to_string())?;
    let row_bytes = width as usize * 4;
    let sheet_row_bytes = sheet_width as usize * 4;
    for (frame_index, svg) in svgs.iter().enumerate() {
        let frame = render_svg(svg, width, height, anti_alias, &resize_mode)?;
        for row in 0..height as usize {
            let source_start = row * row_bytes;
            let destination_start = row * sheet_row_bytes + frame_index * row_bytes;
            sheet.data_mut()[destination_start..destination_start + row_bytes]
                .copy_from_slice(&frame.data()[source_start..source_start + row_bytes]);
        }
    }
    let png = encode_output(&sheet, ai_filter, ai_palette_size)?;
    fs::write(target, png).map_err(|error| format!("Unable to write the tileset PNG: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_a_png_at_the_requested_resolution() {
        let path = env::temp_dir().join(format!("asset-studio-export-test-{}.png", std::process::id()));
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#e7b75a"/></svg>"##;
        export_png(svg.into(), path.to_string_lossy().into_owned(), 32, 24, 0, "contain".into(), false, 16).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn exports_horizontal_tileset_dimensions() {
        let path = env::temp_dir().join(format!("asset-studio-sheet-test-{}.png", std::process::id()));
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill="#e7b75a"/></svg>"##;
        export_tileset(vec![svg.into(), svg.into(), svg.into()], path.to_string_lossy().into_owned(), 12, 9, 0, "contain".into(), false, 16).unwrap();
        let pixmap = tiny_skia::Pixmap::load_png(&path).unwrap();
        assert_eq!((pixmap.width(), pixmap.height()), (36, 9));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn zero_antialias_has_only_binary_alpha() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#e7b75a"/></svg>"##;
        let pixmap = render_svg(svg, 19, 19, 0, "contain").unwrap();
        assert!(pixmap.data().chunks_exact(4).all(|pixel| pixel[3] == 0 || pixel[3] == 255));
    }

    #[test]
    fn configured_offline_ai_returns_a_valid_binary_alpha_png() {
        if env::var("ASSET_STUDIO_PYTHON").is_err() {
            return;
        }
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#e7b75a"/><circle cx="6" cy="6" r="2" fill="#ef6247"/></svg>"##;
        let source = render_svg(svg, 21, 21, 75, "contain").unwrap().encode_png().unwrap();
        let refined = refine_png_bytes(&source, 8).unwrap();
        let pixmap = tiny_skia::Pixmap::decode_png(&refined).unwrap();
        assert_eq!((pixmap.width(), pixmap.height()), (21, 21));
        assert!(pixmap.data().chunks_exact(4).all(|pixel| pixel[3] == 0 || pixel[3] == 255));
    }
}
