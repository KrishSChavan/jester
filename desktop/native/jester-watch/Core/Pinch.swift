import Foundation
import simd

/// Thumb and finger, as the wrist feels them: when they meet and when they part.
///
/// It reads the jump between one 100 Hz acceleration sample and the next, which
/// a moving arm hardly changes and a tap does. How hard that is varies by
/// person and by how the watch sits, so the threshold is learned from your own
/// pinches (`PinchTeacher`); until then, nothing counts as a pinch. A jolt that
/// doesn't die away, is a knock, or arrives while the arm swings, isn't one.
///
/// There's nothing to feel while fingers stay together, but both ends can be
/// felt, and that makes a pinch a button: recordings of a real wrist (see
/// `Tests/pinch-recording.csv`) show fingers parting after a quick pinch as a
/// burst 120 to 200 ms after it, where a pinch being held is silent, and after a
/// hold as a jolt about as strong as the pinch. Mid-drag it's weaker, and the arm
/// makes jolts as big, but in `Tests/pinch-recording-moving.csv` the arm's are
/// broad humps and letting go is a spike standing clear of the moment before, so
/// that's what counts. Some are still missed, so a pinch that has gone still is
/// taken to be over.
struct PinchDetector {
    enum Change: Equatable {
        case together, apart
    }

    /// A jolt worth a look, and what became of it: what tuning goes on.
    struct Heard: Equatable {
        var time: TimeInterval
        var kind: String
        var strength: Double
        var swing: Double
    }

    private enum Phase {
        case idle
        case jolted(since: TimeInterval, peakAt: TimeInterval, peak: Double, calm: Int)
        case together(peakAt: TimeInterval, movedAt: TimeInterval)
        /// Given up on: the real letting go is still to come, and isn't a new pinch.
        case overdue(until: TimeInterval)
    }

    /// Swinging faster than this (rad/s) just beforehand, a jolt is the arm's own.
    /// Real pinches start from a hand that's nearly still, and one that doesn't
    /// would start a drag out of nothing.
    static let maxSpin = 1.0
    /// Samples in a row below half its peak for a jolt to have died away…
    static let calmSamples = 2
    /// …which takes no longer than this, or it's a shake.
    static let maxRing = 0.15
    static let ringsTo = 0.5
    /// After a jolt that wasn't a tap, and after fingers part.
    static let afterShake = 0.15
    static let afterParting = 0.15
    /// How long after the peak the tap's own ring is over, so parting can be heard.
    static let partsFrom = 0.12
    /// Until when that parting is a quick pinch's: small, and the hand swinging back with it.
    static let quickUntil = 0.3
    static let quickSpin = 0.9
    /// How much of what was learned a quick pinch's parting is.
    static let quickShare = 0.31
    /// Letting go of a hold: this much of what was learned, whatever came before…
    static let loudShare = 0.77
    /// …or this much, and this many times the moment before, once the arm is moving.
    static let sharpShare = 0.35
    static let sharpness = 3.0
    /// Below this swing (rad/s) the arm is quiet enough to believe less. Any higher
    /// and it's reached whenever an arm in full flow changes direction.
    static let slowSpin = 0.8
    static let slowShare = 0.28
    static let slowSharpness = 2.5
    /// Above this the arm is too busy to hear a hold let go at all.
    static let holdSpin = 3.0
    /// How many times what was learned makes it a knock, not a pinch.
    static let knockShare = 4.0
    /// Moving at least this fast (rad/s), the arm is being used.
    static let stirring = 0.25
    /// A held pinch with the arm still this long is over, however quietly it ended.
    static let usualStillLimit = 1.5
    static let overdueFor = 3.0
    /// How much each sample moves the arm's own swing: a jolt's few samples hardly do.
    private static let swingShare = 0.2

    /// The jump that counts as fingers meeting, in g. Nil until taught.
    let threshold: Double?
    private let learned: Double
    private let stillLimit: TimeInterval
    private var previous: SIMD3<Double>?
    private var phase = Phase.idle
    private var swing: Double?
    private var quietUntil: TimeInterval = 0
    private var heard: Heard?
    /// The last few jumps: the moment before.
    private var recent: [Double] = []

    init(learned: Double?, ease: PinchEase = .firm, stillLimit: TimeInterval = PinchDetector.usualStillLimit) {
        threshold = learned.map(ease.threshold)
        self.learned = learned ?? 0
        self.stillLimit = stillLimit
    }

    /// When the pinch going on peaked: what `PinchShape` lines up on.
    var peakedAt: TimeInterval? {
        if case .together(let peakAt, _) = phase { return peakAt }
        return nil
    }

    /// The latest jolt, once.
    mutating func takeHeard() -> Heard? {
        defer { heard = nil }
        return heard
    }

    /// Ignore everything until then: a haptic is a jolt too.
    mutating func mute(until time: TimeInterval) {
        quietUntil = max(quietUntil, time)
    }

    private func knock(_ jump: Double) -> Bool {
        jump > learned * Self.knockShare
    }

    /// Whether this jump is a hold being let go, with the arm doing this.
    private func lettingGo(_ jump: Double, swing: Double) -> Bool {
        if swing > Self.holdSpin || knock(jump) { return false }
        if jump >= learned * Self.loudShare { return true }
        let sorted = recent.sorted()
        let before = sorted.isEmpty ? 0 : (sorted[(sorted.count - 1) / 2] + sorted[sorted.count / 2]) / 2
        let slow = swing < Self.slowSpin
        return jump >= learned * (slow ? Self.slowShare : Self.sharpShare) && jump >= before * (slow ? Self.slowSharpness : Self.sharpness)
    }

    /// Start with fingers already together, as in the middle of a drag.
    mutating func assumeTogether(at time: TimeInterval) {
        phase = .together(peakAt: time - Self.quickUntil, movedAt: time)
    }

    /// Forget any pinch: a finger on the screen has taken over.
    mutating func reset() {
        phase = .idle
    }

    mutating func feed(acceleration: SIMD3<Double>, spin: Double, at time: TimeInterval) -> Change? {
        let before = swing ?? spin
        defer {
            previous = acceleration
            swing = before + (spin - before) * Self.swingShare
        }
        guard let threshold, let previous else { return nil }
        let jump = simd_length(acceleration - previous)
        defer { recent = recent.suffix(3) + [jump] }
        switch phase {
        case .idle:
            if time < quietUntil { return nil }
            if jump >= threshold && before <= Self.maxSpin {
                phase = .jolted(since: time, peakAt: time, peak: jump, calm: 0)
            } else if jump >= threshold / 2 {
                heard = Heard(time: time, kind: before > Self.maxSpin ? "swinging" : "weak", strength: jump, swing: before)
            }
        case .jolted(let since, var peakAt, var peak, var calm):
            if jump > peak {
                (peakAt, peak, calm) = (time, jump, 0)
            } else {
                calm = jump < max(threshold / 2, peak * Self.ringsTo) ? calm + 1 : 0
            }
            if knock(peak) || (calm < Self.calmSamples && time - since >= Self.maxRing) {
                phase = .idle
                mute(until: time + Self.afterShake)
                heard = Heard(time: time, kind: "shake", strength: peak, swing: before)
            } else if calm >= Self.calmSamples {
                phase = .together(peakAt: peakAt, movedAt: time)
                heard = Heard(time: time, kind: "together", strength: peak, swing: before)
                return .together
            } else {
                phase = .jolted(since: since, peakAt: peakAt, peak: peak, calm: calm)
            }
        case .together(let peakAt, var movedAt):
            if before >= Self.stirring { movedAt = time }
            let since = time - peakAt
            let quick = since < Self.quickUntil
            let parted = quick ? jump >= learned * Self.quickShare && !knock(jump) && before <= Self.quickSpin : time >= quietUntil && lettingGo(jump, swing: before)
            if since >= Self.partsFrom && parted {
                phase = .idle
                mute(until: time + Self.afterParting)
                heard = Heard(time: time, kind: quick ? "quick" : "letgo", strength: jump, swing: before)
                return .apart
            }
            if !quick && jump >= learned * Self.slowShare {
                heard = Heard(time: time, kind: "heldjolt", strength: jump, swing: before)
            }
            if time - movedAt >= stillLimit {
                phase = .overdue(until: time + Self.overdueFor)
                heard = Heard(time: time, kind: "still", strength: 0, swing: before)
                return .apart
            }
            phase = .together(peakAt: peakAt, movedAt: movedAt)
        case .overdue(let until):
            if jump >= learned * Self.loudShare && !knock(jump) {
                phase = .idle
                mute(until: time + Self.afterParting)
            } else if time >= until {
                phase = .idle
            }
        }
        return nil
    }
}

/// How firm a pinch has to be, on top of what was learned. Teaching is done
/// with care, wrist up and looking at it, and using it isn't.
enum PinchEase: String, CaseIterable {
    case light, normal, firm

    var name: String { rawValue.capitalized }

    /// The jump that counts, given the strength learned.
    func threshold(learned: Double) -> Double {
        let scale = switch self {
        case .light: 0.55
        case .normal: 0.75
        case .firm: 1.0
        }
        return max(PinchTeacher.floor, learned * scale)
    }

    var next: PinchEase {
        let all = Self.allCases
        return all[(all.firstIndex(of: self)! + 1) % all.count]
    }
}

/// Learns the threshold: a moment of stillness, then a few pinches.
struct PinchTeacher {
    static let stillSeconds = 1.5
    static let pinches = 5
    /// Below this (g), a jump is nothing, however quiet the hand.
    static let floor = 0.03
    /// A pinch this much stronger than the still hand can be told from it.
    static let margin = 3.0
    /// A tap's peak is within this of its first sample.
    private static let peakWindow = 0.03
    /// Its ring, after that.
    private static let gap = 0.4

    private var previous: SIMD3<Double>?
    private var start: TimeInterval?
    private var noise = 0.0
    private var lastPeak: TimeInterval = 0
    private(set) var peaks: [Double] = []

    var stillDone: Bool { start != nil && settled }
    private var settled = false

    /// Feed samples until `result` is known.
    mutating func feed(acceleration: SIMD3<Double>, at time: TimeInterval) {
        defer { previous = acceleration }
        guard let previous else { return }
        let jump = simd_length(acceleration - previous)
        let began = start ?? time
        start = began
        if time - began < Self.stillSeconds {
            noise = max(noise, jump)
            return
        }
        settled = true
        guard peaks.count < Self.pinches || time - lastPeak < Self.peakWindow else { return }
        if time - lastPeak < Self.peakWindow {
            if let last = peaks.last, jump > last { peaks[peaks.count - 1] = jump }
        } else if time - lastPeak >= Self.gap, jump >= max(Self.floor, noise * Self.margin) {
            peaks.append(jump)
            lastPeak = time
        }
    }

    /// The learned threshold, once there are enough pinches.
    var result: Double? {
        guard peaks.count >= Self.pinches else { return nil }
        let middle = peaks.sorted()[peaks.count / 2]
        return max(max(Self.floor, noise * Self.margin), middle * 0.6)
    }
}
