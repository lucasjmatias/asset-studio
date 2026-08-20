use std::{collections::BTreeMap, fs, path::Path};

const SUPERSAMPLE: u32 = 4;
const MAX_SAMPLE_SIDE: u32 = 8_192;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct Rgb {
    r: u8,
    g: u8,
    b: u8,
}

#[derive(Clone, Copy)]
struct PixelArtSettings {
    palette_size: u8,
    contour_strength: u8,
    preserve_details: u8,
    coverage_threshold: u8,
}

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

fn parse_svg(svg: &str) -> Result<resvg::usvg::Tree, String> {
    resvg::usvg::Tree::from_data(svg.as_bytes(), &resvg::usvg::Options::default())
        .map_err(|error| format!("Unable to parse the posed SVG: {error}"))
}

fn render_tree(
    tree: &resvg::usvg::Tree,
    width: u32,
    height: u32,
    resize_mode: &str,
) -> Result<tiny_skia::Pixmap, String> {
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
    resvg::render(tree, transform, &mut pixmap.as_mut());
    Ok(pixmap)
}

fn render_svg(
    svg: &str,
    width: u32,
    height: u32,
    anti_alias: u8,
    resize_mode: &str,
) -> Result<tiny_skia::Pixmap, String> {
    validate_dimensions(width, height)?;
    let tree = parse_svg(svg)?;
    let mut pixmap = render_tree(&tree, width, height, resize_mode)?;
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

fn add_color(colors: &mut Vec<Rgb>, color: resvg::usvg::Color) {
    let value = Rgb {
        r: color.red,
        g: color.green,
        b: color.blue,
    };
    if !colors.contains(&value) {
        colors.push(value);
    }
}

fn collect_paint(paint: &resvg::usvg::Paint, colors: &mut Vec<Rgb>) {
    match paint {
        resvg::usvg::Paint::Color(color) => add_color(colors, *color),
        resvg::usvg::Paint::LinearGradient(gradient) => {
            for stop in gradient.stops() {
                add_color(colors, stop.color());
            }
        }
        resvg::usvg::Paint::RadialGradient(gradient) => {
            for stop in gradient.stops() {
                add_color(colors, stop.color());
            }
        }
        resvg::usvg::Paint::Pattern(pattern) => collect_group(pattern.root(), colors),
    }
}

fn collect_group(group: &resvg::usvg::Group, colors: &mut Vec<Rgb>) {
    for node in group.children() {
        match node {
            resvg::usvg::Node::Group(group) => collect_group(group, colors),
            resvg::usvg::Node::Path(path) => {
                if let Some(fill) = path.fill() {
                    collect_paint(fill.paint(), colors);
                }
                if let Some(stroke) = path.stroke() {
                    collect_paint(stroke.paint(), colors);
                }
            }
            resvg::usvg::Node::Text(text) => collect_group(text.flattened(), colors),
            resvg::usvg::Node::Image(_) => {}
        }
    }
}

fn color_distance(left: Rgb, right: Rgb) -> u32 {
    let red = left.r as i32 - right.r as i32;
    let green = left.g as i32 - right.g as i32;
    let blue = left.b as i32 - right.b as i32;
    (red * red * 3 + green * green * 6 + blue * blue * 2) as u32
}

fn nearest_color(color: Rgb, palette: &[Rgb]) -> usize {
    palette
        .iter()
        .enumerate()
        .min_by_key(|(_, candidate)| color_distance(color, **candidate))
        .map(|(index, _)| index)
        .unwrap_or(0)
}

fn reduce_palette(mut colors: Vec<Rgb>, maximum: usize) -> Vec<Rgb> {
    colors.sort();
    colors.dedup();
    if colors.len() <= maximum {
        return colors;
    }
    let first = colors
        .iter()
        .enumerate()
        .min_by_key(|(_, color)| color.r as u32 * 3 + color.g as u32 * 6 + color.b as u32)
        .map(|(index, _)| index)
        .unwrap_or(0);
    let mut chosen = vec![colors[first]];
    while chosen.len() < maximum {
        let next = colors
            .iter()
            .copied()
            .filter(|color| !chosen.contains(color))
            .max_by_key(|color| {
                chosen
                    .iter()
                    .map(|selected| color_distance(*color, *selected))
                    .min()
                    .unwrap_or(0)
            });
        if let Some(color) = next {
            chosen.push(color);
        } else {
            break;
        }
    }
    chosen
}

fn straight_rgb(pixel: &[u8]) -> Option<Rgb> {
    let alpha = pixel[3];
    if alpha < 8 {
        return None;
    }
    Some(Rgb {
        r: ((pixel[0] as u16 * 255 + alpha as u16 / 2) / alpha as u16).min(255) as u8,
        g: ((pixel[1] as u16 * 255 + alpha as u16 / 2) / alpha as u16).min(255) as u8,
        b: ((pixel[2] as u16 * 255 + alpha as u16 / 2) / alpha as u16).min(255) as u8,
    })
}

fn fallback_palette(samples: &tiny_skia::Pixmap, maximum: usize) -> Vec<Rgb> {
    let mut buckets: BTreeMap<(u8, u8, u8), (u64, u64, u64, u64)> = BTreeMap::new();
    let stride = ((samples.width() as usize * samples.height() as usize) / 250_000).max(1);
    for pixel in samples.data().chunks_exact(4).step_by(stride) {
        let Some(color) = straight_rgb(pixel) else {
            continue;
        };
        let weight = pixel[3] as u64;
        let entry = buckets
            .entry((color.r >> 3, color.g >> 3, color.b >> 3))
            .or_default();
        entry.0 += color.r as u64 * weight;
        entry.1 += color.g as u64 * weight;
        entry.2 += color.b as u64 * weight;
        entry.3 += weight;
    }
    let colors = buckets
        .into_values()
        .filter(|value| value.3 > 0)
        .map(|value| Rgb {
            r: (value.0 / value.3) as u8,
            g: (value.1 / value.3) as u8,
            b: (value.2 / value.3) as u8,
        })
        .collect();
    reduce_palette(colors, maximum)
}

fn source_palette(palette_svg: &str, maximum: usize) -> Result<Vec<Rgb>, String> {
    let tree = parse_svg(palette_svg)?;
    let mut colors = Vec::new();
    collect_group(tree.root(), &mut colors);
    Ok(reduce_palette(colors, maximum))
}

fn categorical_pixels(
    samples: &tiny_skia::Pixmap,
    width: usize,
    height: usize,
    sample_scale: usize,
    palette: &[Rgb],
    coverage_threshold: u8,
) -> Vec<Option<usize>> {
    let sample_width = samples.width() as usize;
    let mut labels = vec![None; width * height];
    let full_weight = (sample_scale * sample_scale * 255) as u32;
    for y in 0..height {
        for x in 0..width {
            let mut visible_weight = 0u32;
            let mut votes = vec![0u32; palette.len()];
            for offset_y in 0..sample_scale {
                for offset_x in 0..sample_scale {
                    let sx = x * sample_scale + offset_x;
                    let sy = y * sample_scale + offset_y;
                    let offset = (sy * sample_width + sx) * 4;
                    let pixel = &samples.data()[offset..offset + 4];
                    let alpha = pixel[3] as u32;
                    let Some(color) = straight_rgb(pixel) else {
                        continue;
                    };
                    visible_weight += alpha;
                    votes[nearest_color(color, palette)] += alpha;
                }
            }
            // Coverage is measured before palette selection. This prevents a
            // weak vector touch from becoming an unsupported fully opaque
            // pixel while preserving the categorical (never blended) output.
            if visible_weight * 100 >= full_weight * coverage_threshold.clamp(1, 100) as u32 {
                labels[y * width + x] = votes
                    .iter()
                    .enumerate()
                    .max_by_key(|(_, vote)| **vote)
                    .map(|(index, _)| index);
            }
        }
    }
    labels
}

fn label_at(
    labels: &[Option<usize>],
    width: usize,
    height: usize,
    x: isize,
    y: isize,
) -> Option<usize> {
    if x < 0 || y < 0 || x >= width as isize || y >= height as isize {
        None
    } else {
        labels[y as usize * width + x as usize]
    }
}

fn remove_tiny_clusters(
    labels: &mut Vec<Option<usize>>,
    width: usize,
    height: usize,
    floor: usize,
) {
    if floor <= 1 {
        return;
    }
    let source = labels.clone();
    let mut visited = vec![false; source.len()];
    for start in 0..source.len() {
        let Some(label) = source[start] else {
            continue;
        };
        if visited[start] {
            continue;
        }
        let mut stack = vec![start];
        let mut component = Vec::new();
        visited[start] = true;
        while let Some(index) = stack.pop() {
            component.push(index);
            let x = index % width;
            let y = index / width;
            for (nx, ny) in [
                (x as isize - 1, y as isize),
                (x as isize + 1, y as isize),
                (x as isize, y as isize - 1),
                (x as isize, y as isize + 1),
            ] {
                if nx < 0 || ny < 0 || nx >= width as isize || ny >= height as isize {
                    continue;
                }
                let next = ny as usize * width + nx as usize;
                if !visited[next] && source[next] == Some(label) {
                    visited[next] = true;
                    stack.push(next);
                }
            }
        }
        if component.len() >= floor {
            continue;
        }
        let mut replacements: BTreeMap<Option<usize>, usize> = BTreeMap::new();
        for index in &component {
            let x = index % width;
            let y = index / width;
            for ny in y.saturating_sub(1)..=(y + 1).min(height - 1) {
                for nx in x.saturating_sub(1)..=(x + 1).min(width - 1) {
                    let candidate = source[ny * width + nx];
                    if candidate != Some(label) {
                        *replacements.entry(candidate).or_default() += 1;
                    }
                }
            }
        }
        let replacement = replacements
            .into_iter()
            .max_by_key(|(_, count)| *count)
            .map(|(candidate, _)| candidate)
            .unwrap_or(None);
        for index in component {
            labels[index] = replacement;
        }
    }
}

fn clean_double_corners(labels: &mut Vec<Option<usize>>, width: usize, height: usize) {
    if width < 3 || height < 3 {
        return;
    }
    let source = labels.clone();
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let current = source[y * width + x];
            if current.is_none() {
                continue;
            }
            let north = label_at(&source, width, height, x as isize, y as isize - 1) == current;
            let east = label_at(&source, width, height, x as isize + 1, y as isize) == current;
            let south = label_at(&source, width, height, x as isize, y as isize + 1) == current;
            let west = label_at(&source, width, height, x as isize - 1, y as isize) == current;
            if [north, east, south, west]
                .into_iter()
                .filter(|same| *same)
                .count()
                != 2
            {
                continue;
            }
            let diagonal = if north && east {
                label_at(&source, width, height, x as isize + 1, y as isize - 1)
            } else if east && south {
                label_at(&source, width, height, x as isize + 1, y as isize + 1)
            } else if south && west {
                label_at(&source, width, height, x as isize - 1, y as isize + 1)
            } else if west && north {
                label_at(&source, width, height, x as isize - 1, y as isize - 1)
            } else {
                continue;
            };
            if diagonal != current {
                labels[y * width + x] = diagonal;
            }
        }
    }
}

fn smooth_jaggies(labels: &mut Vec<Option<usize>>, width: usize, height: usize) {
    let source = labels.clone();
    for y in 1..height.saturating_sub(1) {
        for x in 1..width.saturating_sub(1) {
            let index = y * width + x;
            let current = source[index];
            let neighbors = [
                source[index - width],
                source[index + 1],
                source[index + width],
                source[index - 1],
            ];
            let same = neighbors.iter().filter(|label| **label == current).count();
            let mut votes: BTreeMap<Option<usize>, usize> = BTreeMap::new();
            for candidate in neighbors {
                if candidate != current {
                    *votes.entry(candidate).or_default() += 1;
                }
            }
            if same <= 1 {
                if let Some((replacement, count)) =
                    votes.into_iter().max_by_key(|(_, count)| *count)
                {
                    if count >= 3 {
                        labels[index] = replacement;
                    }
                }
            }
        }
    }
}

fn labels_to_pixmap(
    labels: &[Option<usize>],
    palette: &[Rgb],
    width: u32,
    height: u32,
) -> Result<tiny_skia::Pixmap, String> {
    let mut output = tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| "Unable to allocate the pixel-art output.".to_string())?;
    for (pixel, label) in output.data_mut().chunks_exact_mut(4).zip(labels) {
        if let Some(index) = label {
            let color = palette[*index];
            pixel.copy_from_slice(&[color.r, color.g, color.b, 255]);
        } else {
            pixel.fill(0);
        }
    }
    Ok(output)
}

fn render_pixel_art_with_palette(
    svg: &str,
    width: u32,
    height: u32,
    resize_mode: &str,
    settings: PixelArtSettings,
    preferred_palette: &[Rgb],
) -> Result<tiny_skia::Pixmap, String> {
    validate_dimensions(width, height)?;
    let tree = parse_svg(svg)?;
    let maximum_dimension = width.max(height);
    let sample_scale = SUPERSAMPLE.min((MAX_SAMPLE_SIDE / maximum_dimension).max(1));
    let sample_width = width
        .checked_mul(sample_scale)
        .ok_or_else(|| "Pixel-art sampling width overflowed.".to_string())?;
    let sample_height = height
        .checked_mul(sample_scale)
        .ok_or_else(|| "Pixel-art sampling height overflowed.".to_string())?;
    let samples = render_tree(&tree, sample_width, sample_height, resize_mode)?;
    let palette = if preferred_palette.is_empty() {
        fallback_palette(&samples, settings.palette_size.clamp(2, 64) as usize)
    } else {
        preferred_palette.to_vec()
    };
    if palette.is_empty() {
        return tiny_skia::Pixmap::new(width, height)
            .ok_or_else(|| "Unable to allocate the transparent pixel-art output.".to_string());
    }
    let mut labels = categorical_pixels(
        &samples,
        width as usize,
        height as usize,
        sample_scale as usize,
        &palette,
        settings.coverage_threshold,
    );
    remove_tiny_clusters(
        &mut labels,
        width as usize,
        height as usize,
        settings.preserve_details.clamp(1, 4) as usize,
    );
    if settings.contour_strength >= 25 {
        clean_double_corners(&mut labels, width as usize, height as usize);
    }
    if settings.contour_strength >= 75 {
        smooth_jaggies(&mut labels, width as usize, height as usize);
    }
    labels_to_pixmap(&labels, &palette, width, height)
}

fn pixel_settings(
    palette_size: u8,
    contour_strength: u8,
    preserve_details: u8,
    coverage_threshold: u8,
) -> PixelArtSettings {
    PixelArtSettings {
        palette_size: palette_size.clamp(2, 64),
        contour_strength: contour_strength.min(100),
        preserve_details: preserve_details.clamp(1, 4),
        coverage_threshold: coverage_threshold.clamp(1, 100),
    }
}

async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Background image task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn render_pixel_png(
    svg: String,
    palette_svg: String,
    width: u32,
    height: u32,
    resize_mode: String,
    palette_size: u8,
    contour_strength: u8,
    preserve_details: u8,
    coverage_threshold: u8,
) -> Result<Vec<u8>, String> {
    run_blocking(move || {
        let settings = pixel_settings(
            palette_size,
            contour_strength,
            preserve_details,
            coverage_threshold,
        );
        let palette = source_palette(&palette_svg, settings.palette_size as usize)?;
        render_pixel_art_with_palette(&svg, width, height, &resize_mode, settings, &palette)?
            .encode_png()
            .map_err(|error| format!("Unable to encode the pixel-art PNG: {error}"))
    })
    .await
}

fn export_png_sync(
    svg: String,
    palette_svg: String,
    path: String,
    width: u32,
    height: u32,
    anti_alias: u8,
    resize_mode: String,
    pixel_art: bool,
    palette_size: u8,
    contour_strength: u8,
    preserve_details: u8,
    coverage_threshold: u8,
) -> Result<(), String> {
    let target = Path::new(&path);
    validate_png_path(target)?;
    let pixmap = if pixel_art {
        let settings = pixel_settings(
            palette_size,
            contour_strength,
            preserve_details,
            coverage_threshold,
        );
        let palette = source_palette(&palette_svg, settings.palette_size as usize)?;
        render_pixel_art_with_palette(&svg, width, height, &resize_mode, settings, &palette)?
    } else {
        render_svg(&svg, width, height, anti_alias, &resize_mode)?
    };
    let png = pixmap
        .encode_png()
        .map_err(|error| format!("Unable to encode the PNG: {error}"))?;
    fs::write(target, png).map_err(|error| format!("Unable to write the PNG: {error}"))
}

#[tauri::command]
pub(crate) async fn export_png(
    svg: String,
    palette_svg: String,
    path: String,
    width: u32,
    height: u32,
    anti_alias: u8,
    resize_mode: String,
    pixel_art: bool,
    palette_size: u8,
    contour_strength: u8,
    preserve_details: u8,
    coverage_threshold: u8,
) -> Result<(), String> {
    run_blocking(move || {
        export_png_sync(
            svg,
            palette_svg,
            path,
            width,
            height,
            anti_alias,
            resize_mode,
            pixel_art,
            palette_size,
            contour_strength,
            preserve_details,
            coverage_threshold,
        )
    })
    .await
}

fn export_tileset_sync(
    svgs: Vec<String>,
    palette_svg: String,
    path: String,
    width: u32,
    height: u32,
    anti_alias: u8,
    resize_mode: String,
    pixel_art: bool,
    palette_size: u8,
    contour_strength: u8,
    preserve_details: u8,
    coverage_threshold: u8,
) -> Result<(), String> {
    if svgs.is_empty() {
        return Err("The tileset needs at least one frame.".into());
    }
    validate_dimensions(width, height)?;
    let sheet_width = width
        .checked_mul(svgs.len() as u32)
        .filter(|value| *value <= 16_384)
        .ok_or_else(|| {
            "The horizontal tileset would exceed 16384 pixels. Reduce frame width or pose count."
                .to_string()
        })?;
    let target = Path::new(&path);
    validate_png_path(target)?;
    let settings = pixel_settings(
        palette_size,
        contour_strength,
        preserve_details,
        coverage_threshold,
    );
    let palette = if pixel_art {
        source_palette(&palette_svg, settings.palette_size as usize)?
    } else {
        Vec::new()
    };
    let mut sheet = tiny_skia::Pixmap::new(sheet_width, height)
        .ok_or_else(|| "Unable to allocate the tileset bitmap.".to_string())?;
    let row_bytes = width as usize * 4;
    let sheet_row_bytes = sheet_width as usize * 4;
    for (frame_index, svg) in svgs.iter().enumerate() {
        let frame = if pixel_art {
            render_pixel_art_with_palette(svg, width, height, &resize_mode, settings, &palette)?
        } else {
            render_svg(svg, width, height, anti_alias, &resize_mode)?
        };
        for row in 0..height as usize {
            let source_start = row * row_bytes;
            let destination_start = row * sheet_row_bytes + frame_index * row_bytes;
            sheet.data_mut()[destination_start..destination_start + row_bytes]
                .copy_from_slice(&frame.data()[source_start..source_start + row_bytes]);
        }
    }
    let png = sheet
        .encode_png()
        .map_err(|error| format!("Unable to encode the tileset PNG: {error}"))?;
    fs::write(target, png).map_err(|error| format!("Unable to write the tileset PNG: {error}"))
}

#[tauri::command]
pub(crate) async fn export_tileset(
    svgs: Vec<String>,
    palette_svg: String,
    path: String,
    width: u32,
    height: u32,
    anti_alias: u8,
    resize_mode: String,
    pixel_art: bool,
    palette_size: u8,
    contour_strength: u8,
    preserve_details: u8,
    coverage_threshold: u8,
) -> Result<(), String> {
    run_blocking(move || {
        export_tileset_sync(
            svgs,
            palette_svg,
            path,
            width,
            height,
            anti_alias,
            resize_mode,
            pixel_art,
            palette_size,
            contour_strength,
            preserve_details,
            coverage_threshold,
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    const SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="10" height="16" fill="#ef6247"/><rect x="10" width="6" height="16" fill="#13c879"/></svg>"##;

    #[test]
    fn coverage_threshold_rejects_weak_vector_touches() {
        let mut samples = tiny_skia::Pixmap::new(4, 4).unwrap();
        for pixel in samples.data_mut().chunks_exact_mut(4).take(7) {
            pixel.copy_from_slice(&[0, 0, 0, 255]);
        }
        let palette = [Rgb { r: 0, g: 0, b: 0 }];
        assert_eq!(categorical_pixels(&samples, 1, 1, 4, &palette, 40), vec![Some(0)]);
        assert_eq!(categorical_pixels(&samples, 1, 1, 4, &palette, 50), vec![None]);
    }

    #[test]
    fn pixel_art_has_binary_alpha_and_source_colors_only() {
        let settings = pixel_settings(8, 60, 1, 50);
        let palette = source_palette(SVG, 8).unwrap();
        let pixmap =
            render_pixel_art_with_palette(SVG, 19, 19, "contain", settings, &palette).unwrap();
        for pixel in pixmap.data().chunks_exact(4) {
            assert!(pixel[3] == 0 || pixel[3] == 255);
            if pixel[3] == 255 {
                assert!(palette.contains(&Rgb {
                    r: pixel[0],
                    g: pixel[1],
                    b: pixel[2]
                }));
            }
        }
    }

    #[test]
    fn categorical_rasterizer_does_not_create_blended_seam_colors() {
        let settings = pixel_settings(8, 60, 1, 50);
        let palette = source_palette(SVG, 8).unwrap();
        let pixmap =
            render_pixel_art_with_palette(SVG, 13, 11, "stretch", settings, &palette).unwrap();
        let visible: Vec<Rgb> = pixmap
            .data()
            .chunks_exact(4)
            .filter(|pixel| pixel[3] == 255)
            .map(|pixel| Rgb {
                r: pixel[0],
                g: pixel[1],
                b: pixel[2],
            })
            .collect();
        assert!(visible.iter().all(|color| palette.contains(color)));
        assert!(visible.contains(&Rgb {
            r: 239,
            g: 98,
            b: 71
        }));
        assert!(visible.contains(&Rgb {
            r: 19,
            g: 200,
            b: 121
        }));
    }

    #[test]
    fn double_corner_cleanup_removes_the_middle_of_an_l() {
        let mut labels = vec![None; 9];
        labels[1] = Some(0);
        labels[4] = Some(0);
        labels[5] = Some(0);
        clean_double_corners(&mut labels, 3, 3);
        assert_eq!(labels[4], None);
        assert_eq!(labels[1], Some(0));
        assert_eq!(labels[5], Some(0));
    }

    #[test]
    fn ordinary_export_still_honors_binary_alpha() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#e7b75a"/></svg>"##;
        let pixmap = render_svg(svg, 19, 19, 0, "contain").unwrap();
        assert!(
            pixmap
                .data()
                .chunks_exact(4)
                .all(|pixel| pixel[3] == 0 || pixel[3] == 255)
        );
    }

    #[test]
    fn exports_horizontal_tileset_dimensions() {
        let path = std::env::temp_dir().join(format!(
            "asset-studio-sheet-test-{}.png",
            std::process::id()
        ));
        export_tileset_sync(
            vec![SVG.into(), SVG.into(), SVG.into()],
            SVG.into(),
            path.to_string_lossy().into_owned(),
            12,
            9,
            0,
            "contain".into(),
            true,
            8,
            60,
            1,
            50,
        )
        .unwrap();
        let pixmap = tiny_skia::Pixmap::load_png(&path).unwrap();
        assert_eq!((pixmap.width(), pixmap.height()), (36, 9));
        fs::remove_file(path).unwrap();
    }
}
