import CoreMotion
import Foundation
import WatchKit
import simd

/// CMMotionManager is meant to be one per app.
enum Sensors {
    static let motion = CMMotionManager()
    static let rate = 100.0
}

extension SIMD3 where Scalar == Double {
    init(_ v: CMRotationRate) { self.init(v.x, v.y, v.z) }
    init(_ v: CMAcceleration) { self.init(v.x, v.y, v.z) }
}

/// Reading the arm while you steer. A session keeps the watch awake with the
/// wrist down: the app would otherwise be suspended the moment you lower it,
/// which is how you hold a pointer.
final class Steer: NSObject, ObservableObject, WKExtendedRuntimeSessionDelegate {
    /// About 50 frames a second while moving, enough to say "still here" while not.
    private static let frameEvery = 0.02
    private static let idleEvery = 0.2
    private static let hapticJolt = 0.25
    private static let staleAfter = 0.25
    /// A second click this soon gets its own haptic: the Mac is about to double-click or drag.
    private static let pairWithin = 0.65
    /// A pinch still held after this is a hold, and says so on the wrist. No sooner:
    /// a haptic arrives 140 ms after it's asked for, right when fingers would be parting.
    private static let holdFeltAfter = 0.3
    /// How long after a finger lifts its own tap can still turn up.
    private static let tapLingers = 0.2
    private static let heardKept = 500
    static let thresholdKey = "pinchThreshold"
    private static let easeKey = "pinchEase"
    static let kindsKey = "pinchKinds"
    /// Enough for `PinchShape`.
    private static let motionKept = PinchShape.before + PinchShape.after + 15

    @Published private(set) var on = false
    @Published private(set) var note: String?
    @Published private(set) var pinchTaught = UserDefaults.standard.double(forKey: Steer.thresholdKey) > 0
    @Published private(set) var kindsTaught = UserDefaults.standard.data(forKey: Steer.kindsKey) != nil
    @Published private(set) var ease = PinchEase(rawValue: UserDefaults.standard.string(forKey: Steer.easeKey) ?? "") ?? .normal

    private let link: MacLink
    private var runtime: WKExtendedRuntimeSession?
    private var steering = Steering(leftWrist: true, crownOnRight: true)
    private var gather = Gather()
    private var pinch = PinchDetector(learned: nil)
    private var last: TimeInterval?
    private var owed = false
    private var fingerDown = false
    private var pinching = false
    private var pinchedAt: TimeInterval = 0
    private var holdFelt = false
    private var liftedAt: TimeInterval = 0
    private var clickedAt: TimeInterval?
    private var heard: [PinchDetector.Heard] = []
    private var kinds: PinchKinds?
    private var motions: [MotionSample] = []
    /// This pinch's fingers: nil until there's enough of it to tell.
    private var allFingers: Bool?

    init(link: MacLink) {
        self.link = link
    }

    /// Back from teaching: what the screen says about pinches may have changed.
    func checkPinch() {
        pinchTaught = UserDefaults.standard.double(forKey: Self.thresholdKey) > 0
        kindsTaught = UserDefaults.standard.data(forKey: Self.kindsKey) != nil
    }

    /// On to the next of Light, Normal, Firm. Takes effect at Start.
    func changeEase() {
        ease = ease.next
        UserDefaults.standard.set(ease.rawValue, forKey: Self.easeKey)
    }

    func start() {
        guard !on, Sensors.motion.isDeviceMotionAvailable else { return }
        note = nil
        let device = WKInterfaceDevice.current()
        steering = Steering(leftWrist: device.wristLocation == .left, crownOnRight: device.crownOrientation == .right)
        let threshold = UserDefaults.standard.double(forKey: Self.thresholdKey)
        pinch = PinchDetector(learned: threshold > 0 ? threshold : nil, ease: ease)
        kinds = UserDefaults.standard.data(forKey: Self.kindsKey).flatMap { try? JSONDecoder().decode(PinchKinds.self, from: $0) }
        motions = []
        gather = Gather()
        last = nil
        let session = WKExtendedRuntimeSession()
        session.delegate = self
        session.start()
        runtime = session
        Sensors.motion.deviceMotionUpdateInterval = 1 / Sensors.rate
        Sensors.motion.startDeviceMotionUpdates(to: .main) { [weak self] motion, _ in
            if let motion { self?.sample(motion) }
        }
        on = true
    }

    func stop() {
        guard on else { return }
        on = false
        fingerDown = false
        pinching = false
        Sensors.motion.stopDeviceMotionUpdates()
        saveHeard()
        link.sendMotion(yaw: 0, pitch: 0, milliseconds: 1, steering: false)
        runtime?.invalidate()
        runtime = nil
    }

    /// A click with no press to it: Double Tap on the Click button.
    private func click() {
        link.click()
        owed = true
        felt()
    }

    /// The wrist hears a click land. The haptic is a jolt of its own to ignore.
    private func felt() {
        let now = ProcessInfo.processInfo.systemUptime
        pinch.mute(until: now + Self.hapticJolt)
        let second = clickedAt.map { now - $0 < Self.pairWithin } ?? false
        clickedAt = second ? nil : now
        WKInterfaceDevice.current().play(second ? .start : .click)
    }

    /// Thumb and finger meeting and parting: to the Mac, the same press the Click button makes.
    private func fingers(_ change: PinchDetector.Change) {
        owed = true
        pinching = change == .together
        allFingers = nil
        if pinching {
            pinchedAt = ProcessInfo.processInfo.systemUptime
            holdFelt = false
        } else if holdFelt {
            pinch.mute(until: ProcessInfo.processInfo.systemUptime + Self.hapticJolt)
            WKInterfaceDevice.current().play(.click)
        } else {
            felt()
        }
    }

    /// What pinches have felt like, kept here for tuning. Nothing sends it anywhere:
    /// `devicectl device copy from` reads it off a watch in Developer Mode.
    private func saveHeard() {
        guard !heard.isEmpty, let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let rows = heard.map { "\($0.time),\($0.kind),\($0.strength),\($0.swing)" }
        let table = (["time,kind,strength,swing"] + rows).joined(separator: "\n")
        try? table.write(to: folder.appendingPathComponent("pinches.csv"), atomically: true, encoding: .utf8)
    }

    /// A finger on the Click button or off it: the Mac makes that a tap or a hold.
    func press(_ down: Bool) {
        guard on, down != fingerDown else { return }
        fingerDown = down
        owed = true
        // Landing on the screen jolts the wrist as a pinch does, and it's this that counts.
        pinch.reset()
        pinching = false
        allFingers = nil
        let now = ProcessInfo.processInfo.systemUptime
        if down { return }
        liftedAt = now
        pinch.mute(until: now + Self.hapticJolt)
        WKInterfaceDevice.current().play(.click)
    }

    /// The Click button's own action. A finger's press has been reported already,
    /// so this is the one way to press it without a finger: Double Tap.
    func tapped() {
        guard on, !fingerDown, ProcessInfo.processInfo.systemUptime - liftedAt > Self.tapLingers else { return }
        click()
    }

    private func sample(_ motion: CMDeviceMotion) {
        let dt = last.map { min(0.1, max(0, motion.timestamp - $0)) } ?? 1 / Sensors.rate
        last = motion.timestamp
        let spin = SIMD3<Double>(motion.rotationRate)
        motions = motions.suffix(Self.motionKept - 1) + [MotionSample(time: motion.timestamp, acceleration: SIMD3(motion.userAcceleration), rotation: spin)]
        let turn = steering.rates(spin: spin, gravity: SIMD3(motion.gravity))
        gather.add(yaw: turn.yaw, pitch: turn.pitch, over: dt)
        if let change = pinch.feed(acceleration: SIMD3(motion.userAcceleration), spin: simd_length(spin), at: motion.timestamp), !fingerDown { fingers(change) }
        if let jolt = pinch.takeHeard() { heard = heard.suffix(Self.heardKept - 1) + [jolt] }
        if pinching, allFingers == nil, let kinds, let peak = pinch.peakedAt, let shape = PinchShape.around(peak: peak, in: motions) {
            allFingers = kinds.isAllFingers(PinchShape.features(shape))
            owed = true
        }
        if pinching, !holdFelt, motion.timestamp - pinchedAt >= Self.holdFeltAfter {
            holdFelt = true
            // It lands a moment later, as a jolt that mustn't read as letting go.
            pinch.mute(until: motion.timestamp + Self.hapticJolt + (allFingers == true ? 0.1 : 0))
            WKInterfaceDevice.current().play(allFingers == true ? .start : .click)
        }
        let due = gather.waiting >= (gather.isStill ? Self.idleEvery : Self.frameEvery)
        // Waiting on a busy radio loses nothing: it all goes in the next frame.
        // A lost connection does: motion from then would arrive as one great jump.
        guard link.canSendMotion else {
            if gather.waiting > Self.staleAfter { gather = Gather() }
            return
        }
        guard due || owed else { return }
        let frame = gather.take()
        owed = false
        link.sendMotion(yaw: frame.yaw, pitch: frame.pitch, milliseconds: frame.milliseconds, steering: true, held: fingerDown || pinching, whole: pinching && allFingers == true)
    }

    func extendedRuntimeSessionDidStart(_ session: WKExtendedRuntimeSession) {}

    func extendedRuntimeSessionWillExpire(_ session: WKExtendedRuntimeSession) {
        note = "Steering stops after an hour. Tap Start to go on."
        WKInterfaceDevice.current().play(.stop)
    }

    func extendedRuntimeSession(_ session: WKExtendedRuntimeSession, didInvalidateWith reason: WKExtendedRuntimeSessionInvalidationReason, error: Error?) {
        guard session === runtime else { return }
        runtime = nil
        if reason != .none { note = error.map { "Stopped: \($0.localizedDescription)" } ?? "Steering stopped" }
        stop()
    }
}

/// Learning how your pinch feels, with the arm at rest.
final class Teach: ObservableObject {
    @Published private(set) var heard = 0
    @Published private(set) var still = true
    @Published private(set) var done = false
    @Published private(set) var strength = 0.0

    private var teacher = PinchTeacher()

    func start() {
        teacher = PinchTeacher()
        heard = 0
        still = true
        done = false
        Sensors.motion.deviceMotionUpdateInterval = 1 / Sensors.rate
        Sensors.motion.startDeviceMotionUpdates(to: .main) { [weak self] motion, _ in
            if let motion { self?.sample(motion) }
        }
    }

    func stop() {
        if !done { Sensors.motion.stopDeviceMotionUpdates() }
    }

    private func sample(_ motion: CMDeviceMotion) {
        teacher.feed(acceleration: SIMD3(motion.userAcceleration), at: motion.timestamp)
        still = !teacher.stillDone
        // No haptic per pinch: it would be felt as the next one.
        heard = teacher.peaks.count
        guard let threshold = teacher.result else { return }
        Sensors.motion.stopDeviceMotionUpdates()
        UserDefaults.standard.set(threshold, forKey: Steer.thresholdKey)
        strength = threshold
        done = true
        WKInterfaceDevice.current().play(.success)
    }
}
