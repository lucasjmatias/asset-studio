use std::{fs, path::Path};

#[tauri::command]
fn export_png(
    svg: String,
    path: String,
    width: u32,
    height: u32,
    anti_alias: u8,
    resize_mode: String,
) -> Result<(), String> {
    if width == 0 || height == 0 || width > 16_384 || height > 16_384 {
        return Err("Export dimensions must be between 1 and 16384 pixels.".into());
    }

    let target = Path::new(&path);
    if target.extension().and_then(|value| value.to_str()).map(str::to_ascii_lowercase)
        != Some("png".into())
    {
        return Err("The export path must use the .png extension.".into());
    }

    let options = resvg::usvg::Options::default();
    let tree = resvg::usvg::Tree::from_data(svg.as_bytes(), &options)
        .map_err(|error| format!("Unable to parse the posed SVG: {error}"))?;
    let source_size = tree.size();
    let mut pixmap = tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| "Unable to allocate the export bitmap.".to_string())?;
    let scale_x = width as f32 / source_size.width();
    let scale_y = height as f32 / source_size.height();
    let transform = if resize_mode == "contain" {
        let scale = scale_x.min(scale_y);
        let translate_x = (width as f32 - source_size.width() * scale) / 2.0;
        let translate_y = (height as f32 - source_size.height() * scale) / 2.0;
        tiny_skia::Transform::from_row(scale, 0.0, 0.0, scale, translate_x, translate_y)
    } else if resize_mode == "stretch" {
        tiny_skia::Transform::from_scale(scale_x, scale_y)
    } else {
        return Err("Resize mode must be contain or stretch.".into());
    };
    resvg::render(&tree, transform, &mut pixmap.as_mut());

    // resvg returns premultiplied RGBA. Blend between a hard alpha cutout and its
    // native antialiasing so zero is strictly binary while 100 preserves Skia edges.
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

    let png = pixmap
        .encode_png()
        .map_err(|error| format!("Unable to encode the PNG: {error}"))?;
    fs::write(target, png).map_err(|error| format!("Unable to write the PNG: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![export_png])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_a_png_at_the_requested_resolution() {
        let path = std::env::temp_dir().join(format!(
            "asset-studio-export-test-{}.png",
            std::process::id()
        ));
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#e7b75a"/></svg>"##;
        export_png(
            svg.to_string(),
            path.to_string_lossy().into_owned(),
            32,
            24,
            0,
            "contain".into(),
        )
        .expect("the SVG should export");

        let bytes = fs::read(&path).expect("the PNG should exist");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        fs::remove_file(path).expect("the export fixture should be removable");
    }

    #[test]
    fn zero_antialias_has_only_binary_alpha() {
        let path = std::env::temp_dir().join(format!(
            "asset-studio-alpha-test-{}.png",
            std::process::id()
        ));
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#e7b75a"/></svg>"##;
        export_png(svg.into(), path.to_string_lossy().into_owned(), 19, 19, 0, "contain".into())
            .expect("the SVG should export");
        let pixmap = tiny_skia::Pixmap::load_png(&path).expect("the PNG should decode");
        assert!(pixmap.data().chunks_exact(4).all(|pixel| pixel[3] == 0 || pixel[3] == 255));
        fs::remove_file(path).expect("the export fixture should be removable");
    }
}
