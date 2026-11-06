import CoreMotion
import Foundation
import SwiftUI
import WatchKit

/// A minute of raw motion around pinches, with ticks saying when: what it takes
/// to find out whether a wrist can feel a pinch being let go, which a pinch held
/// to drag would depend on. It stays on the watch, in `Documents/lab.csv`, until
/// read with `devicectl device copy from`.
final class Lab: NSObject, ObservableObject, WKExtendedRuntimeSessionDelegate {
    private struct Part {
        let name: String
        let intro: String
        /// What each tick asks for, in turn.
        let cues: [String]
        let ticks: Int
        let every: TimeInterval
    }

    private static let parts = [
        Part(name: "one", intro: "On each tick: one quick pinch, index finger", cues: ["One finger"], ticks: 12, every: 1.5),
        Part(name: "all", intro: "On each tick: one quick pinch, all fingers", cues: ["All fingers"], ticks: 12, every: 1.5),
        Part(name: "mix", intro: "Take turns: index, then all, then index…", cues: ["One finger", "All fingers"], ticks: 20, every: 1.5),
        Part(name: "hold", intro: "All fingers and hold, move a bit. Let go on the next tick", cues: ["All fingers, hold", "Let go"], ticks: 10, every: 2.5)
    ]
    private static let readFor: TimeInterval = 4

    @Published private(set) var headline = "Get ready"
    @Published private(set) var detail = ""
    @Published private(set) var done = false

    private var runtime: WKExtendedRuntimeSession?
    private var timer: Timer?
    private var fused: [Double] = []
    private var raw: [Double] = []
    private var marks: [(TimeInterval, String)] = []

    func start() {
        guard runtime == nil, Sensors.motion.isDeviceMotionAvailable else { return }
        let session = WKExtendedRuntimeSession()
        session.delegate = self
        session.start()
        runtime = session
        Sensors.motion.deviceMotionUpdateInterval = 1 / Sensors.rate
        Sensors.motion.startDeviceMotionUpdates(to: .main) { [weak self] motion, _ in
            guard let self, let motion else { return }
            let (a, r, g) = (motion.userAcceleration, motion.rotationRate, motion.gravity)
            self.fused += [motion.timestamp, a.x, a.y, a.z, r.x, r.y, r.z, g.x, g.y, g.z]
        }
        Sensors.motion.accelerometerUpdateInterval = 1 / Sensors.rate
        Sensors.motion.startAccelerometerUpdates(to: .main) { [weak self] data, _ in
            guard let self, let data else { return }
            self.raw += [data.timestamp, data.acceleration.x, data.acceleration.y, data.acceleration.z]
        }
        begin(0)
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        guard runtime != nil else { return }
        Sensors.motion.stopDeviceMotionUpdates()
        Sensors.motion.stopAccelerometerUpdates()
        runtime?.invalidate()
        runtime = nil
    }

    private func mark(_ label: String) {
        marks.append((ProcessInfo.processInfo.systemUptime, label))
    }

    private func begin(_ index: Int) {
        guard index < Self.parts.count else { return finish() }
        let part = Self.parts[index]
        headline = part.intro
        detail = "Part \(index + 1) of \(Self.parts.count)"
        mark("part \(part.name)")
        WKInterfaceDevice.current().play(.notification)
        wait(Self.readFor) { [weak self] in self?.tick(part, 1, of: index) }
    }

    private func tick(_ part: Part, _ number: Int, of index: Int) {
        guard number <= part.ticks else { return begin(index + 1) }
        let cue = part.cues[(number - 1) % part.cues.count]
        headline = cue
        detail = "\(number) of \(part.ticks)"
        mark("\(part.name) \(cue.lowercased()) \(number)")
        WKInterfaceDevice.current().play(.click)
        wait(part.every) { [weak self] in self?.tick(part, number + 1, of: index) }
    }

    private func wait(_ seconds: TimeInterval, then next: @escaping () -> Void) {
        timer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { _ in next() }
    }

    private func finish() {
        stop()
        save()
        headline = "Done"
        detail = "Thanks. Tell Claude it’s saved."
        done = true
        WKInterfaceDevice.current().play(.success)
    }

    private func save() {
        guard let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        var rows = marks.map { "mark,\($0.0),\($0.1)" }
        rows.reserveCapacity(rows.count + fused.count / 10 + raw.count / 4)
        for start in stride(from: 0, to: fused.count - 9, by: 10) {
            rows.append("fused," + fused[start..<start + 10].map { String($0) }.joined(separator: ","))
        }
        for start in stride(from: 0, to: raw.count - 3, by: 4) {
            rows.append("raw," + raw[start..<start + 4].map { String($0) }.joined(separator: ","))
        }
        try? rows.joined(separator: "\n").write(to: folder.appendingPathComponent("lab.csv"), atomically: true, encoding: .utf8)
    }

    func extendedRuntimeSessionDidStart(_ session: WKExtendedRuntimeSession) {}
    func extendedRuntimeSessionWillExpire(_ session: WKExtendedRuntimeSession) {}
    func extendedRuntimeSession(_ session: WKExtendedRuntimeSession, didInvalidateWith reason: WKExtendedRuntimeSessionInvalidationReason, error: Error?) {}
}

struct LabView: View {
    @StateObject private var lab = Lab()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 8) {
            Text(lab.headline)
                .font(.title3)
                .multilineTextAlignment(.center)
            Text(lab.detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if lab.done { Button("Close") { dismiss() } }
        }
        .onAppear { lab.start() }
        .onDisappear { lab.stop() }
    }
}
