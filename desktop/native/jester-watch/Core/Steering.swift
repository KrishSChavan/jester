import Foundation
import simd

/// Turns the watch's spin into a turn and a tilt of the arm.
///
/// The gyroscope reports spin around the watch's own axes, which point
/// somewhere new whenever the wrist rolls. Gravity says which way is really
/// up, so the turn is the spin around up, and the tilt is the spin around the
/// level line across the forearm. How the hand is held doesn't change either,
/// and rolling the wrist moves neither.
struct Steering {
    /// Along the forearm, towards the fingers, on the watch's axes: the crown is +x.
    private let forearm: SIMD3<Double>
    private var level = SIMD3<Double>(0, 0, 0)

    init(leftWrist: Bool, crownOnRight: Bool) {
        forearm = SIMD3(leftWrist == crownOnRight ? 1 : -1, 0, 0)
    }

    /// Radians a second: turning right and tipping up are positive.
    mutating func rates(spin: SIMD3<Double>, gravity: SIMD3<Double>) -> (yaw: Double, pitch: Double) {
        guard simd_length(gravity) > 0 else { return (0, 0) }
        let up = -simd_normalize(gravity)
        let flat = forearm - simd_dot(forearm, up) * up
        // With the arm near vertical, "forward" means little: keep the last one.
        if simd_length(flat) > 0.25 { level = simd_normalize(flat) }
        let right = simd_cross(level, up)
        return (-simd_dot(spin, up), simd_dot(spin, right))
    }
}

/// Gathers fast motion samples into slower frames, losing nothing to rounding.
struct Gather {
    private var yaw = 0.0
    private var pitch = 0.0
    private var seconds = 0.0
    /// One frame's units a radian (see `Report`).
    private static let units = 10_000.0

    var waiting: Double { seconds }
    var isStill: Bool { abs(yaw) * Self.units < 1 && abs(pitch) * Self.units < 1 }

    mutating func add(yaw rate: Double, pitch tilt: Double, over dt: Double) {
        yaw += rate * dt
        pitch += tilt * dt
        seconds += dt
    }

    mutating func take() -> (yaw: Int16, pitch: Int16, milliseconds: UInt8) {
        let sentYaw = (yaw * Self.units).rounded().clamped(to: -32000...32000)
        let sentPitch = (pitch * Self.units).rounded().clamped(to: -32000...32000)
        yaw -= sentYaw / Self.units
        pitch -= sentPitch / Self.units
        let milliseconds = UInt8((seconds * 1000).rounded().clamped(to: 1...255))
        seconds = 0
        return (Int16(sentYaw), Int16(sentPitch), milliseconds)
    }
}

extension Double {
    func clamped(to range: ClosedRange<Double>) -> Double {
        Swift.min(range.upperBound, Swift.max(range.lowerBound, self))
    }
}
