import CoreMotion
import Foundation
import SwiftUI
import WatchKit

/// Teaching the two pinches apart, then checking on pinches it hasn't seen, all
/// in one sitting because that's what the difference between them depends on.
/// Held pinches, as those are the only ones it's ever asked about. What it heard
/// is saved to `Documents/kinds.csv`, on the watch, for tuning.
final class TeachKinds: NSObject, ObservableObject, WKExtendedRuntimeSessionDelegate {
    private static let taught = 20
    private static let checked = 12
    private static let holdFor: TimeInterval = 1.6
    private static let restFor: TimeInterval = 1.4
    private static let readFor: TimeInterval = 4
    /// Right this many times in `checked` and it's trusted with your windows.
    static let needed = 11

    @Published private(set) var headline = "Get ready"
    @Published private(set) var detail = "Take turns: index, then all fingers. Pinch and hold each one, at your usual strength"
    @Published private(set) var done = false

    private var runtime: WKExtendedRuntimeSession?
    private var timer: Timer?
    private var detector = PinchDetector(learned: nil)
    private var motions: [MotionSample] = []
    private var trial = 0
    private var wantAll = false
    private var heard: (peak: TimeInterval, shape: [MotionSample]?)?
    private var training: [(all: Bool, features: [Double])] = []
    private var checking: [(all: Bool, features: [Double])] = []
    private var rows: [String] = []

    func start() {
        guard runtime == nil, Sensors.motion.isDeviceMotionAvailable else { return }
        detector = PinchDetector(learned: UserDefaults.standard.double(forKey: Steer.thresholdKey), ease: .light)
        let session = WKExtendedRuntimeSession()
        session.delegate = self
        session.start()
        runtime = session
        Sensors.motion.deviceMotionUpdateInterval = 1 / Sensors.rate
        Sensors.motion.startDeviceMotionUpdates(to: .main) { [weak self] motion, _ in
            if let motion { self?.sample(motion) }
        }
        WKInterfaceDevice.current().play(.notification)
        timer = Timer.scheduledTimer(withTimeInterval: Self.readFor, repeats: false) { [weak self] _ in self?.next() }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        guard runtime != nil else { return }
        Sensors.motion.stopDeviceMotionUpdates()
        runtime?.invalidate()
        runtime = nil
    }

    private func sample(_ motion: CMDeviceMotion) {
        let spin = SIMD3<Double>(motion.rotationRate)
        motions = motions.suffix(PinchShape.before + PinchShape.after + 14) + [MotionSample(time: motion.timestamp, acceleration: SIMD3(motion.userAcceleration), rotation: spin)]
        if detector.feed(acceleration: SIMD3(motion.userAcceleration), spin: simd_length(spin), at: motion.timestamp) == .together, let peak = detector.peakedAt, heard == nil {
            heard = (peak, nil)
        }
        if let pending = heard, pending.shape == nil, let shape = PinchShape.around(peak: pending.peak, in: motions) {
            heard = (pending.peak, shape)
        }
    }

    private var total: Int { Self.taught + Self.checked }

    private func next() {
        guard trial < total else { return finish() }
        wantAll = trial.isMultiple(of: 2) == false
        heard = nil
        detector.reset()
        headline = wantAll ? "All fingers" : "Index finger"
        detail = "Pinch and hold · \(trial + 1) of \(total)"
        WKInterfaceDevice.current().play(.click)
        timer = Timer.scheduledTimer(withTimeInterval: Self.holdFor, repeats: false) { [weak self] _ in self?.letGo() }
    }

    private func letGo() {
        if let shape = heard?.shape {
            let features = PinchShape.features(shape)
            if trial < Self.taught {
                training.append((wantAll, features))
            } else {
                checking.append((wantAll, features))
            }
            rows += shape.map { "\(trial),\(wantAll),\($0.time),\($0.acceleration.x),\($0.acceleration.y),\($0.acceleration.z),\($0.rotation.x),\($0.rotation.y),\($0.rotation.z)" }
        }
        trial += 1
        headline = "Let go"
        WKInterfaceDevice.current().play(.click)
        timer = Timer.scheduledTimer(withTimeInterval: Self.restFor, repeats: false) { [weak self] _ in self?.next() }
    }

    private func split(_ pinches: [(all: Bool, features: [Double])]) -> (index: [[Double]], all: [[Double]]) {
        (pinches.filter { !$0.all }.map(\.features), pinches.filter(\.all).map(\.features))
    }

    private func finish() {
        stop()
        done = true
        if let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            try? (["trial,all,time,ax,ay,az,rx,ry,rz"] + rows).joined(separator: "\n").write(to: folder.appendingPathComponent("kinds.csv"), atomically: true, encoding: .utf8)
        }
        let taught = split(training)
        guard let kinds = PinchKinds(index: taught.index, all: taught.all), checking.count >= Self.checked - 2 else {
            headline = "Try again"
            detail = "Too few pinches were felt: \(training.count + checking.count) of \(total)"
            WKInterfaceDevice.current().play(.failure)
            return
        }
        let right = checking.filter { kinds.isAllFingers($0.features) == $0.all }.count
        let passed = right * Self.checked >= Self.needed * checking.count
        headline = "\(right) of \(checking.count) right"
        if passed, let final = PinchKinds(index: split(training + checking).index, all: split(training + checking).all), let saved = try? JSONEncoder().encode(final) {
            UserDefaults.standard.set(saved, forKey: Steer.kindsKey)
            detail = "All-finger holds now move windows."
            WKInterfaceDevice.current().play(.success)
        } else {
            detail = "Not reliable enough yet, so window moving stays off."
            WKInterfaceDevice.current().play(.failure)
        }
    }

    func extendedRuntimeSessionDidStart(_ session: WKExtendedRuntimeSession) {}
    func extendedRuntimeSessionWillExpire(_ session: WKExtendedRuntimeSession) {}
    func extendedRuntimeSession(_ session: WKExtendedRuntimeSession, didInvalidateWith reason: WKExtendedRuntimeSessionInvalidationReason, error: Error?) {}
}

struct TeachKindsView: View {
    @StateObject private var teach = TeachKinds()
    @EnvironmentObject private var steer: Steer
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 8) {
            Text(teach.headline)
                .font(.title3)
                .multilineTextAlignment(.center)
            Text(teach.detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if teach.done {
                Button("Close") {
                    steer.checkPinch()
                    dismiss()
                }
            }
        }
        .onAppear { teach.start() }
        .onDisappear { teach.stop() }
    }
}
