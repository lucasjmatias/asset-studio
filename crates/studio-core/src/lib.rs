use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GroupTransform {
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub pivot_x: f64,
    pub pivot_y: f64,
}

impl Default for GroupTransform {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            rotation: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            pivot_x: 0.0,
            pivot_y: 0.0,
        }
    }
}

impl GroupTransform {
    /// SVG affine matrix in the order:
    /// translation * pivot * rotation * scale * inverse-pivot.
    pub fn matrix(self) -> [f64; 6] {
        let radians = self.rotation.to_radians();
        let cosine = radians.cos();
        let sine = radians.sin();
        let a = cosine * self.scale_x;
        let b = sine * self.scale_x;
        let c = -sine * self.scale_y;
        let d = cosine * self.scale_y;
        let e = self.x + self.pivot_x - a * self.pivot_x - c * self.pivot_y;
        let f = self.y + self.pivot_y - b * self.pivot_x - d * self.pivot_y;
        [a, b, c, d, e, f]
    }
}

#[wasm_bindgen]
pub fn transform_matrix(
    x: f64,
    y: f64,
    rotation: f64,
    scale_x: f64,
    scale_y: f64,
    pivot_x: f64,
    pivot_y: f64,
) -> Vec<f64> {
    GroupTransform {
        x,
        y,
        rotation,
        scale_x,
        scale_y,
        pivot_x,
        pivot_y,
    }
    .matrix()
    .to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn identity_is_stable() {
        assert_eq!(GroupTransform::default().matrix(), [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    }

    #[test]
    fn rotation_keeps_the_pivot_fixed() {
        let matrix = GroupTransform {
            rotation: 90.0,
            pivot_x: 10.0,
            pivot_y: 20.0,
            ..Default::default()
        }
        .matrix();
        let transformed_x = matrix[0] * 10.0 + matrix[2] * 20.0 + matrix[4];
        let transformed_y = matrix[1] * 10.0 + matrix[3] * 20.0 + matrix[5];
        assert_relative_eq!(transformed_x, 10.0, epsilon = 1e-9);
        assert_relative_eq!(transformed_y, 20.0, epsilon = 1e-9);
    }
}
