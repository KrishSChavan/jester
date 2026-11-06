import Foundation
import simd

/// One moment of the wrist, kept to tell pinches apart.
struct MotionSample: Equatable {
    var time: TimeInterval
    var acceleration: SIMD3<Double>
    var rotation: SIMD3<Double>
}

/// What a pinch looks like from the first instants, before anyone could know how
/// long it will last. A recording of a real wrist tells an index pinch from all
/// fingers by this, 17 or 18 times in 20, when the two are done the same way
/// (`Tests/pinch-recording-fingers.csv`). Done differently, lighter say, it does
/// little better than chance, which is why it's taught in one sitting and scored
/// on pinches it hasn't seen. Only a held pinch is ever asked: a click stays a click.
enum PinchShape {
    /// Samples needed either side of the peak, at 100 Hz.
    static let before = 20
    static let after = 10
    private static let stretches = [(-8, -3), (-3, 1), (1, 5), (5, 10)]

    /// The samples around a peak, from those kept, once there are enough.
    static func around(peak time: TimeInterval, in kept: [MotionSample]) -> [MotionSample]? {
        guard let peak = kept.lastIndex(where: { $0.time <= time }), peak >= before, peak + after < kept.count else { return nil }
        return Array(kept[(peak - before)...(peak + after)])
    }

    /// `samples` run from `before` ahead of the peak to `after` behind it.
    static func features(_ samples: [MotionSample]) -> [Double] {
        let at = { (offset: Int) in samples[before + offset] }
        let calm = (-20 ..< -10).map(at)
        let still = calm.reduce(SIMD3<Double>()) { $0 + $1.acceleration } / Double(calm.count)
        let turning = calm.reduce(SIMD3<Double>()) { $0 + $1.rotation } / Double(calm.count)
        var features: [Double] = []
        for (from, to) in stretches {
            let stretch = (from..<to).map(at)
            let count = Double(stretch.count)
            let pushed = stretch.reduce(SIMD3<Double>()) { $0 + $1.acceleration - still } / count
            let turned = stretch.reduce(SIMD3<Double>()) { $0 + $1.rotation - turning } / count
            let jumps = (from..<to).reduce(0) { $0 + simd_length(at($1).acceleration - at($1 - 1).acceleration) }
            let twist = (stretch.reduce(0) { $0 + simd_length_squared($1.rotation - turning) } / count).squareRoot()
            features += [pushed.x, pushed.y, pushed.z, turned.x, turned.y, turned.z, jumps, twist]
        }
        return features
    }
}

/// Which fingers, as taught: the measurements that differ most between the two
/// kinds of pinch, weighed by how much.
struct PinchKinds: Codable, Equatable {
    static let kept = 8
    private var picks: [Int]
    private var weights: [Double]
    private var middles: [Double]
    private var spreads: [Double]

    init?(index: [[Double]], all: [[Double]]) {
        guard index.count >= 2, all.count >= 2, let width = index.first?.count else { return nil }
        let measure = { (rows: [[Double]], feature: Int) -> (mean: Double, variance: Double) in
            let mean = rows.reduce(0) { $0 + $1[feature] } / Double(rows.count)
            return (mean, rows.reduce(0) { $0 + ($1[feature] - mean) * ($1[feature] - mean) } / Double(rows.count))
        }
        let scored = (0..<width).map { feature -> (feature: Int, weight: Double, middle: Double, spread: Double) in
            let (one, every) = (measure(index, feature), measure(all, feature))
            let spread = ((one.variance + every.variance) / 2).squareRoot() + 1e-9
            return (feature, (every.mean - one.mean) / spread, (every.mean + one.mean) / 2, spread)
        }
        let best = scored.sorted { abs($0.weight) > abs($1.weight) }.prefix(Self.kept)
        picks = best.map(\.feature)
        weights = best.map(\.weight)
        middles = best.map(\.middle)
        spreads = best.map(\.spread)
    }

    func isAllFingers(_ features: [Double]) -> Bool {
        picks.indices.reduce(0) { $0 + weights[$1] * (features[picks[$1]] - middles[$1]) / spreads[$1] } > 0
    }
}
