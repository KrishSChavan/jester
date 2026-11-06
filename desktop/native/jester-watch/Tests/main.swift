import CryptoKit
import Foundation
import simd

// `node --test` runs this through tests/desktop-watch.test.mjs: the watch's and
// the Mac's logic, with no Bluetooth, no motion sensors and no watch.

var failures = 0
var checks = 0

func check(_ ok: @autoclosure () -> Bool, _ what: String, line: Int = #line) {
    checks += 1
    if !ok() {
        failures += 1
        print("FAIL line \(line): \(what)")
    }
}

func near(_ a: Double, _ b: Double, _ slack: Double = 1e-6) -> Bool { abs(a - b) < slack }

/// A whole pairing, with `tamper` standing where the radio would be.
func pair(tamper: (Data) -> Data = { $0 }) -> (WatchPairing, MacPairing) {
    var watch = WatchPairing()
    var mac = MacPairing()
    var toMac = watch.opening()
    while !toMac.isEmpty {
        var toWatch: [Data] = []
        for frame in toMac { toWatch += mac.receive(tamper(frame)) }
        toMac = []
        for frame in toWatch { toMac += watch.receive(tamper(frame)) }
    }
    return (watch, mac)
}

// Every frame fits what any Bluetooth link can carry.
do {
    let (watch, _) = pair()
    for frame in watch.opening() { check(frame.count <= Wire.frameSize, "commit frame fits") }
    var session = WatchSession(key: SymmetricKey(size: .bits256), opening: Data(repeating: 6, count: 17))
    check(session.frame(yaw: 1, pitch: 2, milliseconds: 20, steering: true).count == Wire.frameSize, "a motion frame is exactly one frame")
}

// Frames: split and back together, in any order.
do {
    let blob = Data((0..<32).map { UInt8($0) })
    let parts = Frames.split(.macKey, blob)
    check(parts.count == 2, "32 bytes take two frames")
    var assembly = Frames.Assembly()
    check(assembly.add(parts[1]) == nil, "not whole yet")
    check(assembly.add(parts[0]) == blob, "whole, out of order")
    var repeated = Frames.Assembly()
    check(repeated.add(parts[0]) == nil, "not whole yet")
    check(repeated.add(parts[0]) == nil, "the same part twice is still not whole")
    check(repeated.add(parts[1]) == blob, "whole")
}

// Pairing agrees on a key and a code, and only then.
do {
    let (watch, mac) = pair()
    check(watch.code != nil && watch.code == mac.code, "both show the same code")
    check(watch.code?.count == 6, "six digits")
    check(watch.key?.raw == mac.key?.raw, "both hold the same key")
    check(!mac.failed, "no failure")
    check(watch.confirmed(by: mac.confirmation()!), "the watch believes the Mac's confirmation")

    let other = pair().0
    check(!other.confirmed(by: mac.confirmation()!), "another watch doesn't")
    var forged = mac.confirmation()!
    forged[forged.startIndex + 3] ^= 1
    check(!watch.confirmed(by: forged), "a changed confirmation isn't believed")
    check(pair().0.code != watch.code, "each pairing has its own code")
}

// Someone in the middle swapping the watch's key is caught by the commitment.
do {
    var mac = MacPairing()
    var watch = WatchPairing()
    var replies: [Data] = []
    for frame in watch.opening() { replies += mac.receive(frame) }
    var keys: [Data] = []
    for frame in replies { keys += watch.receive(frame) }
    // A different key from the one committed to.
    let other = Frames.split(.watchKey, Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation)
    for frame in other { _ = mac.receive(frame) }
    check(mac.failed, "a key that isn't the committed one ends pairing")
    check(mac.key == nil && mac.code == nil, "and leaves no key or code")
    check(mac.confirmation() == nil, "and nothing to confirm")
}

// Without a confirmation nothing moves; a session is proved frame by frame.
do {
    let (watchSide, macSide) = pair()
    let key = macSide.key!
    var mac = MacSession(key: key)
    var watch = WatchSession(key: watchSide.key!, opening: mac.opening)

    let first = watch.frame(yaw: 120, pitch: -40, milliseconds: 20, steering: true)
    check(mac.receive(first) == Report(yaw: 120, pitch: -40, milliseconds: 20, steering: true, click: false), "a signed frame reads back")
    check(mac.receive(first) == nil, "a replayed frame doesn't")

    var changed = watch.frame(yaw: 5, pitch: 5, milliseconds: 20, steering: true)
    changed[changed.startIndex + 5] ^= 0x40
    check(mac.receive(changed) == nil, "a changed frame doesn't")
    check(mac.receive(watch.frame(yaw: 7, pitch: 0, milliseconds: 20, steering: true))?.yaw == 7, "and the next good one does")

    // A frame from an earlier connection is worthless in this one.
    var nextMac = MacSession(key: key)
    check(nextMac.receive(first) == nil, "an old connection's frame doesn't")

    var stranger = WatchSession(key: SymmetricKey(size: .bits256), opening: mac.opening)
    check(mac.receive(stranger.frame(yaw: 9, pitch: 9, milliseconds: 20, steering: true)) == nil, "a stranger's key doesn't")

    var unpaired = MacSession(key: nil)
    var hopeful = WatchSession(key: key, opening: unpaired.opening)
    check(unpaired.receive(hopeful.frame(yaw: 9, pitch: 9, milliseconds: 20, steering: true)) == nil, "a Mac with no key believes nothing")

    check(mac.receive(Data([Kind.motion.rawValue, 1, 2])) == nil, "a short frame is nothing")
    check(mac.receive(Data()) == nil, "an empty frame is nothing")
}

// A click arrives once, even if the frame carrying it is lost.
do {
    let key = SymmetricKey(size: .bits256)
    var mac = MacSession(key: key)
    var watch = WatchSession(key: key, opening: mac.opening)
    let frame = { (watch: inout WatchSession) in watch.frame(yaw: 0, pitch: 0, milliseconds: 20, steering: true) }
    check(mac.receive(frame(&watch))?.click == false, "no click yet")
    watch.click()
    _ = frame(&watch) // Lost on the way.
    check(mac.receive(frame(&watch))?.click == true, "the next frame carries it")
    check(mac.receive(frame(&watch))?.click == false, "and only once")
    watch.click()
    check(mac.receive(frame(&watch))?.click == true, "a second click is a second click")
    for _ in 0..<300 { watch.click() }
    check(mac.receive(frame(&watch))?.click == true, "the count wrapping loses nothing")
}

// The Click button, held: said in every frame, and signed with the rest of it.
do {
    let key = SymmetricKey(size: .bits256)
    var mac = MacSession(key: key)
    var watch = WatchSession(key: key, opening: mac.opening)
    let plain = mac.receive(watch.frame(yaw: 0, pitch: 0, milliseconds: 20, steering: true))
    check(plain?.held == false && plain?.steering == true, "not held unless it says so")
    let held = mac.receive(watch.frame(yaw: 0, pitch: 0, milliseconds: 20, steering: true, held: true))
    check(held?.held == true && held?.steering == true, "held, and still steering")
    check(mac.receive(watch.frame(yaw: 0, pitch: 0, milliseconds: 20, steering: false, held: true))?.steering == false, "the two don't get mixed up")
    var forged = [UInt8](watch.frame(yaw: 0, pitch: 0, milliseconds: 20, steering: true))
    forged[10] |= 2
    check(mac.receive(Data(forged)) == nil, "and nobody can press it for you")
}

// All fingers, as a press: signed like the rest, and separate from it.
do {
    let key = SymmetricKey(size: .bits256)
    var mac = MacSession(key: key)
    var watch = WatchSession(key: key, opening: mac.opening)
    check(mac.receive(watch.frame(yaw: 0, pitch: 0, milliseconds: 20, steering: true, held: true))?.whole == false, "a press isn't all fingers unless it says so")
    let whole = mac.receive(watch.frame(yaw: 0, pitch: 0, milliseconds: 20, steering: true, held: true, whole: true))
    check(whole?.whole == true && whole?.held == true && whole?.steering == true, "and the three stay apart")
    var forged = [UInt8](watch.frame(yaw: 0, pitch: 0, milliseconds: 20, steering: true, held: true))
    forged[10] |= 4
    check(mac.receive(Data(forged)) == nil, "nobody can turn a press into moving your windows")
}

// Which fingers, on real pinches: ten of each taking turns, each judged by the others.
do {
    let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("pinch-recording-fingers.csv")
    var ticks: [(time: Double, all: Bool)] = []
    var samples: [MotionSample] = []
    for line in try! String(contentsOf: file, encoding: .utf8).split(separator: "\n") {
        let cells = line.split(separator: ",")
        if cells[0] == "m" {
            ticks.append((Double(cells[1])!, cells[2].contains("all")))
        } else {
            let v = cells.map { Double($0)! }
            samples.append(MotionSample(time: v[0], acceleration: SIMD3(v[1], v[2], v[3]), rotation: SIMD3(v[4], v[5], v[6])))
        }
    }
    var pinches: [(all: Bool, features: [Double])] = []
    for (i, tick) in ticks.enumerated() {
        let end = min(i + 1 < ticks.count ? ticks[i + 1].time + 0.05 : tick.time + 1.5, tick.time + 1.2)
        let inside = samples.indices.filter { samples[$0].time >= tick.time + 0.22 && samples[$0].time < end && $0 > 0 }
        let jump = { (at: Int) in simd_length(samples[at].acceleration - samples[at - 1].acceleration) }
        guard let peak = inside.max(by: { jump($0) < jump($1) }) else { continue }
        guard let shape = PinchShape.around(peak: samples[peak].time, in: samples) else { continue }
        pinches.append((tick.all, PinchShape.features(shape)))
    }
    check(pinches.count == 20, "twenty pinches found (\(pinches.count))")
    var right = 0
    for (i, pinch) in pinches.enumerated() {
        let others = pinches.indices.filter { $0 != i }.map { pinches[$0] }
        let kinds = PinchKinds(index: others.filter { !$0.all }.map(\.features), all: others.filter(\.all).map(\.features))
        if kinds?.isAllFingers(pinch.features) == pinch.all { right += 1 }
    }
    print("  which fingers: \(right)/20")
    check(right >= 15, "most pinches are told apart (\(right)/20; by chance about 10)")
    let kinds = PinchKinds(index: pinches.filter { !$0.all }.map(\.features), all: pinches.filter(\.all).map(\.features))
    let saved = try! JSONDecoder().decode(PinchKinds.self, from: JSONEncoder().encode(kinds))
    check(saved == kinds, "what's taught survives being saved")
    check(PinchKinds(index: [], all: []) == nil, "nothing is learned from nothing")
    let few = samples.prefix(10).map { $0 }
    check(PinchShape.around(peak: few[5].time, in: few) == nil, "too soon after the pinch there's nothing to go on")
}

// Steering: which way is which, on a left wrist, crown towards the hand.
do {
    var left = Steering(leftWrist: true, crownOnRight: true)
    let level = SIMD3<Double>(0, 0, -1) // Palm down: the screen faces up.
    var r = left.rates(spin: SIMD3(0, 0, -1), gravity: level)
    check(near(r.yaw, 1) && near(r.pitch, 0), "turning right, clockwise from above, is +yaw")
    r = left.rates(spin: SIMD3(0, -1, 0), gravity: level)
    check(near(r.yaw, 0) && near(r.pitch, 1), "tipping the fingers up is +pitch")
    r = left.rates(spin: SIMD3(1, 0, 0), gravity: level)
    check(near(r.yaw, 0) && near(r.pitch, 0), "rolling the wrist moves nothing")

    // The same turn, with the hand on its side (the screen facing left).
    var sideways = Steering(leftWrist: true, crownOnRight: true)
    let onSide = SIMD3<Double>(0, -1, 0)
    r = sideways.rates(spin: SIMD3(0, -1, 0), gravity: onSide)
    check(near(r.yaw, 1) && near(r.pitch, 0), "a turn is a turn with the hand on its side")
    r = sideways.rates(spin: SIMD3(0, 0, 1), gravity: onSide)
    check(near(r.yaw, 0) && near(r.pitch, 1), "and a tip is a tip")
    r = sideways.rates(spin: SIMD3(1, 0, 0), gravity: onSide)
    check(near(r.yaw, 0) && near(r.pitch, 0), "and a roll is still nothing")

    // Pointing up at the screen, as you do: the turn and the tip are still true.
    var pointing = Steering(leftWrist: true, crownOnRight: true)
    let tilt = 0.5.squareRoot()
    let raisedUp = SIMD3<Double>(tilt, 0, tilt) // Up, on the watch's axes, with the arm at 45°.
    r = pointing.rates(spin: -raisedUp, gravity: -raisedUp)
    check(near(r.yaw, 1) && near(r.pitch, 0), "turning right with the arm raised")
    r = pointing.rates(spin: SIMD3(0, -1, 0), gravity: -raisedUp)
    check(near(r.yaw, 0) && near(r.pitch, 1), "tipping up with the arm raised, at full strength (\(r.pitch))")

    // Crown towards the elbow: the forearm runs the other way along the watch.
    var flipped = Steering(leftWrist: true, crownOnRight: false)
    r = flipped.rates(spin: SIMD3(0, 1, 0), gravity: SIMD3(0, 0, -1))
    check(near(r.pitch, 1), "tipping up, with the watch turned round")
    var right = Steering(leftWrist: false, crownOnRight: false)
    r = right.rates(spin: SIMD3(0, -1, 0), gravity: SIMD3(0, 0, -1))
    check(near(r.pitch, 1), "right wrist, crown towards the hand, as the left")

    // Arm straight up: there's no forward; the last one stands.
    var raised = Steering(leftWrist: true, crownOnRight: true)
    _ = raised.rates(spin: .zero, gravity: level)
    r = raised.rates(spin: SIMD3(0, 0, -1), gravity: SIMD3(-1, 0, 0))
    check(r.yaw.isFinite && r.pitch.isFinite, "stays a number with the arm vertical")
    r = raised.rates(spin: SIMD3(1, 0, 0), gravity: .zero)
    check(r.yaw == 0 && r.pitch == 0, "no gravity reading, no motion")
}

// Gathering: nothing lost to rounding.
do {
    var gather = Gather()
    var sent = 0
    for _ in 0..<1000 {
        gather.add(yaw: 0.0123, pitch: 0, over: 0.01)
        sent += Int(gather.take().yaw)
    }
    check(abs(Double(sent) - 1230) <= 1, "1000 tiny steps add up (sent \(sent))")
    gather = Gather()
    gather.add(yaw: 40, pitch: -40, over: 1)
    let big = gather.take()
    check(big.yaw == 32000 && big.pitch == -32000, "a huge swing clamps, not crashes")
    check(big.milliseconds == 255, "and so does a long wait")
    let rest = gather.take()
    check(rest.yaw == 32000, "the rest of it follows")
    gather = Gather()
    check(gather.isStill, "nothing gathered is still")
    gather.add(yaw: 0, pitch: 0, over: 0.001)
    check(gather.take().milliseconds == 1, "time never reads as zero")
}

// All the way through: a wrist turning, in frames, to what the Mac reads.
do {
    let key = SymmetricKey(size: .bits256)
    var mac = MacSession(key: key)
    var watch = WatchSession(key: key, opening: mac.opening)
    var steering = Steering(leftWrist: true, crownOnRight: true)
    var gather = Gather()
    var yaw = 0
    var pitch = 0
    var milliseconds = 0
    var frames = 0
    for sample in 1...100 {
        // Half a radian a second to the right, a quarter up, for a second, at 100 Hz.
        let turn = steering.rates(spin: SIMD3(0, -0.25, -0.5), gravity: SIMD3(0, 0, -1))
        gather.add(yaw: turn.yaw, pitch: turn.pitch, over: 0.01)
        guard sample % 2 == 0 else { continue }
        let out = gather.take()
        let report = mac.receive(watch.frame(yaw: out.yaw, pitch: out.pitch, milliseconds: out.milliseconds, steering: true))
        yaw += Int(report?.yaw ?? 0)
        pitch += Int(report?.pitch ?? 0)
        milliseconds += Int(report?.milliseconds ?? 0)
        frames += 1
    }
    check(frames == 50, "fifty frames a second")
    check(abs(yaw - 5000) <= 1, "half a radian reads as 5000 units, as steerBy expects (\(yaw))")
    check(abs(pitch - 2500) <= 1, "a quarter as 2500 (\(pitch))")
    check(milliseconds == 1000, "and a second as a second (\(milliseconds))")
}

/// Samples at 100 Hz: `script` gives the acceleration at each. When fingers met.
func run(_ detector: inout PinchDetector, _ samples: [SIMD3<Double>], spin: Double = 0, from start: Double = 0) -> [Double] {
    var fired: [Double] = []
    for (i, sample) in samples.enumerated() {
        let time = start + Double(i) / 100
        if detector.feed(acceleration: sample, spin: spin, at: time) == .together { fired.append(time) }
    }
    return fired
}

/// Everything fingers did, and when.
func changes(_ detector: inout PinchDetector, _ samples: [SIMD3<Double>], spin: Double = 0, from start: Double = 0) -> [(Double, PinchDetector.Change)] {
    var seen: [(Double, PinchDetector.Change)] = []
    for (i, sample) in samples.enumerated() {
        let time = start + Double(i) / 100
        if let change = detector.feed(acceleration: sample, spin: spin, at: time) { seen.append((time, change)) }
    }
    return seen
}

let rest = SIMD3<Double>(0.01, 0, 0)
let tap = SIMD3<Double>(0.4, 0.1, 0)

// How firm a pinch has to be scales what was learned, down to a floor.
do {
    check(near(PinchEase.firm.threshold(learned: 0.4), 0.4), "firm is as taught")
    check(PinchEase.normal.threshold(learned: 0.4) < 0.4, "normal is easier than that")
    check(PinchEase.light.threshold(learned: 0.4) < PinchEase.normal.threshold(learned: 0.4), "light is easier still")
    check(near(PinchEase.light.threshold(learned: 0.04), PinchTeacher.floor), "but never below the floor")
    check(PinchEase.light.next == .normal && PinchEase.normal.next == .firm && PinchEase.firm.next == .light, "the button goes round all three")
    check(PinchEase.allCases.allSatisfy { PinchEase(rawValue: $0.rawValue) == $0 }, "and it survives being saved")
}

// A pinch: one sharp jolt that dies away.
do {
    var detector = PinchDetector(learned: 0.2)
    let fired = run(&detector, [rest, rest, tap, rest, rest, rest, rest, rest])
    check(fired.count == 1, "one jolt is one pinch (\(fired.count))")

    var untaught = PinchDetector(learned: nil)
    check(run(&untaught, [rest, tap, rest, rest, rest, rest]).isEmpty, "untaught, nothing counts")

    var faint = PinchDetector(learned: 0.2)
    let small = SIMD3<Double>(0.1, 0, 0)
    check(run(&faint, [rest, small, rest, rest, rest, rest]).isEmpty, "below the threshold is nothing")

    var swinging = PinchDetector(learned: 0.2)
    check(run(&swinging, [rest, tap, rest, rest, rest, rest], spin: 3).isEmpty, "a jolt mid-swing is the arm")

    var shaking = PinchDetector(learned: 0.2)
    let shake = (0..<40).map { $0 % 2 == 0 ? rest : tap }
    check(run(&shaking, shake).isEmpty, "shaking isn't a pinch")

    var slow = PinchDetector(learned: 0.2)
    let ramp = (0..<100).map { SIMD3<Double>(Double($0) * 0.01, 0, 0) }
    check(run(&slow, ramp).isEmpty, "a smooth push isn't a pinch")

    var ringing = PinchDetector(learned: 0.2)
    let twice = [rest, tap, rest, rest, rest, rest, rest, tap, rest, rest, rest, rest]
    check(run(&ringing, twice).count == 1, "a tap's ring isn't a second pinch")

    var again = PinchDetector(learned: 0.2)
    let pause = [SIMD3<Double>](repeating: rest, count: 50)
    // Fingers parting after a quick pinch: a small burst some 150 ms after the tap.
    let parting = SIMD3<Double>(0.09, 0, 0)
    let two = [rest, tap] + Array(repeating: rest, count: 14) + [parting] + pause + [tap] + pause
    check(run(&again, two).count == 2, "two pinches apart are two")

    // A firm tap rings on past the threshold: its jumps here are 1.0, 0.6, 0.35, 0.25.
    var firm = PinchDetector(learned: 0.3)
    let firmTap = [0.0, 1.0, 0.4, 0.75, 0.5, 0.5, 0.5, 0.5].map { SIMD3<Double>($0, 0, 0) }
    check(run(&firm, firmTap).count == 1, "a firm tap counts, however long it rings")

    // Its peak can come a sample after the jolt began: jumps of 0.25, 1.0, 0.6, 0.35.
    var building = PinchDetector(learned: 0.3)
    let rising = [0.0, 0.25, 1.25, 0.65, 1.0, 1.0, 1.0, 1.0].map { SIMD3<Double>($0, 0, 0) }
    check(run(&building, rising).count == 1, "a tap that builds is judged on its real peak")

    var ringsOn = PinchDetector(learned: 0.2)
    let drone = [0.0, 0.3, 0.05, 0.3, 0.05, 0.3, 0.05, 0.3].map { SIMD3<Double>($0, 0, 0) }
    check(run(&ringsOn, drone).isEmpty, "one that doesn't fade at all is still a shake")

    // A firm tap jolts the wrist as well, starting a moment before the acceleration
    // peaks and lasting a few samples: the swing that counts is the arm's, before it.
    var jolted = PinchDetector(learned: 0.2)
    var count = 0
    for (i, sample) in [rest, rest, rest, rest, tap, rest, rest, rest, rest, rest].enumerated() {
        if jolted.feed(acceleration: sample, spin: (3...6).contains(i) ? 4 : 0.1, at: Double(i) / 100) == .together { count += 1 }
    }
    check(count == 1, "the tap's own jolt to the wrist doesn't rule it out")

    var noted = PinchDetector(learned: 0.2)
    _ = run(&noted, [rest, rest, tap, rest, rest, rest, rest])
    let note = noted.takeHeard()
    check(note?.kind == "together" && note?.strength ?? 0 > 0.3, "a pinch is noted, with how hard it was")
    check(noted.takeHeard() == nil, "once")
    var weak = PinchDetector(learned: 0.2)
    _ = run(&weak, [rest, SIMD3(0.13, 0, 0), rest])
    check(weak.takeHeard()?.kind == "weak", "and so is a near miss, for tuning")

    let quickly = [rest, rest, tap] + Array(repeating: rest, count: 14) + [parting] + Array(repeating: rest, count: 16)
    var quick = PinchDetector(learned: 0.2)
    let once = changes(&quick, quickly)
    check(once.map(\.1) == [.together, .apart], "a quick pinch: fingers meet and part")
    check(once.count == 2 && once[1].0 - once[0].0 < 0.25, "soon enough to be a click")
    var both = PinchDetector(learned: 0.2)
    check(run(&both, quickly + quickly).count == 2, "and a second straight after it is a second pinch")

    var held = PinchDetector(learned: 0.2, stillLimit: 9)
    let gently = [rest, rest, tap] + Array(repeating: rest, count: 40)
    check(changes(&held, gently).map(\.1) == [.together], "nothing to feel while they stay together")
    check(held.feed(acceleration: SIMD3(0.3, 0, 0), spin: 0, at: 0.5) == .apart, "and a hold ends with a jolt of its own")

    // Rattling, every other jump large: it never settles, so it's never a tap.
    var rattle = PinchDetector(learned: 0.2)
    let rattling = (0..<40).map { SIMD3<Double>(Double(($0 + 1) / 2) * 0.3 + Double($0 / 2) * 0.02, 0, 0) }
    check(run(&rattle, rattling).isEmpty, "a rattle isn't a pinch, however brief its lulls")

    var muted = PinchDetector(learned: 0.2, stillLimit: 9)
    _ = run(&muted, [rest, rest, tap, rest, rest, rest, rest, rest, rest])
    muted.mute(until: 3)
    _ = run(&muted, Array(repeating: rest, count: 10), from: 0.09)
    check(muted.feed(acceleration: SIMD3(0.09, 0, 0), spin: 0, at: 0.19) == .apart, "fingers part")
    check(run(&muted, gently, from: 1).isEmpty, "and that doesn't cut a haptic's quiet short")

    var faintly = PinchDetector(learned: 0.2, stillLimit: 9)
    let later = gently + [SIMD3(0.05, 0, 0)] + Array(repeating: rest, count: 5)
    check(changes(&faintly, later).map(\.1) == [.together], "too faint to be a hold's ending, though not a quick pinch's")

    // Moving, it's the shape that counts: a hump of jumps isn't letting go, a spike is.
    var humped = PinchDetector(learned: 0.2, stillLimit: 9)
    var hump = 0.0
    var humps = 0
    for i in 0..<60 {
        hump += i.isMultiple(of: 2) ? 0.1 : -0.09
        if i == 8 { humped.assumeTogether(at: 0.08) }
        if humped.feed(acceleration: SIMD3(hump, 0, 0), spin: 2, at: Double(i) / 100) == .apart { humps += 1 }
    }
    check(humps == 0, "moving, a run of jumps as big as a release isn't one")
    var spiked = PinchDetector(learned: 0.2, stillLimit: 9)
    spiked.assumeTogether(at: 0)
    for i in 0..<30 { _ = spiked.feed(acceleration: rest, spin: 2, at: Double(i) / 100) }
    check(spiked.feed(acceleration: SIMD3(0.09, 0, 0), spin: 2, at: 0.3) == .apart, "a small spike out of nothing is")
    var tick = PinchDetector(learned: 0.2, stillLimit: 9)
    tick.assumeTogether(at: 0)
    for i in 0..<30 { _ = tick.feed(acceleration: rest, spin: 0, at: Double(i) / 100) }
    tick.mute(until: 0.5)
    check(tick.feed(acceleration: SIMD3(0.09, 0, 0), spin: 0, at: 0.3) == nil, "and the watch's own tick isn't")

    var busy = PinchDetector(learned: 0.2, stillLimit: 9)
    _ = run(&busy, gently)
    for i in 0..<40 { _ = busy.feed(acceleration: rest, spin: 5, at: 0.23 + Double(i) / 100) }
    check(busy.feed(acceleration: SIMD3(0.3, 0, 0), spin: 5, at: 0.63) == nil, "with the arm thrashing, a jolt says nothing")
    _ = busy.feed(acceleration: rest, spin: 5, at: 0.64)
    for i in 0..<40 { _ = busy.feed(acceleration: rest, spin: 0, at: 0.65 + Double(i) / 100) }
    check(busy.feed(acceleration: SIMD3(0.3, 0, 0), spin: 0, at: 1.05) == .apart, "and once it's calm again, it does")

    var quiet = PinchDetector(learned: 0.2)
    var spent: [(Double, PinchDetector.Change)] = []
    for i in 0..<220 {
        let time = Double(i) / 100
        if let change = quiet.feed(acceleration: i == 3 ? tap : rest, spin: 0, at: time) { spent.append((time, change)) }
    }
    check(spent.map(\.1) == [.together, .apart], "a pinch that goes quiet and still is taken to be over")
    check(spent.count == 2 && abs(spent[1].0 - spent[0].0 - PinchDetector.usualStillLimit) < 0.1, "after a moment")
    check(quiet.feed(acceleration: SIMD3(0.3, 0, 0), spin: 0, at: 2.3) == nil, "and its real letting go, when it comes, isn't a new pinch")
    _ = quiet.feed(acceleration: rest, spin: 0, at: 2.31)
    check(run(&quiet, gently, from: 2.6).count == 1, "though the next one is")

    var moving = PinchDetector(learned: 0.2)
    var stayed = 0
    for i in 0..<400 {
        let change = moving.feed(acceleration: i == 3 ? tap : rest, spin: i < 10 ? 0 : 0.6, at: Double(i) / 100)
        if change == .apart { stayed += 1 }
    }
    check(stayed == 0, "held while the arm moves, it isn't over however long that takes")

    var knocked = PinchDetector(learned: 0.2, stillLimit: 9)
    _ = run(&knocked, gently)
    check(knocked.feed(acceleration: SIMD3(1.5, 0, 0), spin: 0, at: 0.5) == nil, "a knock on the desk isn't letting go")
    var banged = PinchDetector(learned: 0.2)
    let bang = [rest, rest, SIMD3(1.5, 0, 0)] + Array(repeating: rest, count: 10)
    check(run(&banged, bang).isEmpty, "and it isn't a pinch either")

    var finger = PinchDetector(learned: 0.2, stillLimit: 9)
    _ = run(&finger, gently)
    finger.reset()
    check(finger.feed(acceleration: SIMD3(0.3, 0, 0), spin: 0, at: 0.5) == nil, "a finger on the screen takes over: no pinch is left to end")

    var haptic = PinchDetector(learned: 0.2)
    haptic.mute(until: 0.5)
    check(run(&haptic, [rest, tap, rest, rest, rest, rest]).isEmpty, "the watch's own haptic isn't a pinch")
}

// The real thing: a wrist recorded doing what this has to tell apart, on ticks,
// with the arm at rest: six quick pinches, then holds, then holds with the arm
// swinging. On it, a quick pinch's parting is 0.115 to 0.19 g where a held pinch
// is under 0.05, and letting go of a hold is 0.29 to 0.48.
do {
    let learned = 0.2868
    let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("pinch-recording.csv")
    var marks: [(time: Double, label: String)] = []
    var samples: [(time: Double, acceleration: SIMD3<Double>, spin: Double)] = []
    for line in try! String(contentsOf: file, encoding: .utf8).split(separator: "\n") {
        let cells = line.split(separator: ",")
        if cells[0] == "m" {
            marks.append((Double(cells[1])!, String(cells[2])))
        } else {
            let v = cells.map { Double($0)! }
            samples.append((v[0], SIMD3(v[1], v[2], v[3]), v[4]))
        }
    }
    check(samples.count > 6000, "the recording is there (\(samples.count) samples)")

    /// What the detector made of one part, from its first tick.
    func heard(_ part: String, _ ease: PinchEase, stillLimit: Double = PinchDetector.usualStillLimit) -> [PinchDetector.Heard] {
        let start = marks.first { $0.label == "\(part) press 1" }!.time
        let end = marks.first { $0.time > start && $0.label.hasPrefix("part") }?.time ?? .infinity
        var detector = PinchDetector(learned: learned, ease: ease, stillLimit: stillLimit)
        var notes: [PinchDetector.Heard] = []
        // The recording's own ticks, which aren't there in real use, land a moment after each mark.
        var ticks = marks.map(\.time).filter { $0 >= start }
        for sample in samples where sample.time >= start && sample.time < end {
            if let tick = ticks.first, sample.time >= tick + 0.1 {
                detector.mute(until: tick + 0.24)
                ticks.removeFirst()
            }
            _ = detector.feed(acceleration: sample.acceleration, spin: sample.spin, at: sample.time)
            if let note = detector.takeHeard(), !["weak", "swinging"].contains(note.kind) { notes.append(note) }
        }
        return notes
    }
    func tick(_ label: String) -> Double { marks.first { $0.label == label }!.time }

    for ease in [PinchEase.normal, .light] {
        let name = ease.name
        let quick = heard("quick", ease).filter { $0.kind != "shake" }
        check(quick.map(\.kind) == Array(repeating: ["together", "quick"], count: 6).flatMap { $0 }, "\(name): six quick pinches, each felt meeting and parting (\(quick.map(\.kind)))")
        for pair in stride(from: 0, to: quick.count - 1, by: 2) {
            check(quick[pair + 1].time - quick[pair].time < 0.2, "\(name): parted in time to be a click")
        }

        let holds = heard("hold", ease)
        check(!holds.contains { $0.kind == "quick" }, "\(name): no hold is taken for a quick pinch (\(holds.map(\.kind)))")
        let long = heard("hold", ease, stillLimit: 9)
        for (press, release) in [(1, 2), (3, 4), (5, 6)] {
            let pressed = tick("hold press \(press)")
            let letGo = tick("hold release \(release)")
            check(long.contains { $0.kind == "together" && $0.time > pressed && $0.time < pressed + 1 }, "\(name): hold \(press) begins")
            check(long.contains { $0.kind == "letgo" && $0.time > letGo && $0.time < letGo + 1 }, "\(name): and ends when it's let go")
            check(!long.contains { $0.kind == "letgo" && $0.time > pressed && $0.time < letGo }, "\(name): not before")
        }

        let moving = heard("move", ease)
        check(!moving.contains { $0.kind == "quick" }, "\(name): nor is one with the arm swinging (\(moving.map(\.kind)))")
        check(moving.filter { $0.kind == "together" }.count >= 2, "\(name): which still counts as held")
    }
}

// Letting go mid-drag, recorded: held on the move, let go without stopping. Two
// recordings, so that what fixes one can't quietly break the other.
do {
    let learned = 0.2868
    let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    func load(_ name: String) -> (marks: [(time: Double, label: String)], samples: [(time: Double, acceleration: SIMD3<Double>, spin: Double)]) {
        var marks: [(time: Double, label: String)] = []
        var samples: [(time: Double, acceleration: SIMD3<Double>, spin: Double)] = []
        for line in try! String(contentsOf: here.appendingPathComponent(name), encoding: .utf8).split(separator: "\n") {
            let cells = line.split(separator: ",")
            if cells[0] == "m" {
                marks.append((Double(cells[1])!, String(cells[2])))
            } else {
                let v = cells.map { Double($0)! }
                samples.append((v[0], SIMD3(v[1], v[2], v[3]), v[4]))
            }
        }
        return (marks, samples)
    }
    /// Each hold of a part, from a moment after it began: let go in time, too soon, or missed.
    func holds(_ name: String, _ part: String) -> (caught: Int, early: Int, missed: Int) {
        let (marks, samples) = load(name)
        let ticks = marks.filter { !$0.label.hasPrefix("part") }
        var result = (caught: 0, early: 0, missed: 0)
        for (press, release) in zip(ticks, ticks.dropFirst()) where press.label.hasPrefix("\(part) press") && release.label.hasPrefix("\(part) release") {
            let start = press.time + (part == "steady" ? 1.5 : 1)
            var detector = PinchDetector(learned: learned, ease: .normal, stillLimit: 9)
            var began = false
            var ended: Double?
            var hapticMuted = false
            for sample in samples where sample.time >= start - 0.3 && sample.time < release.time + 1.1 {
                if !began && sample.time >= start {
                    detector.assumeTogether(at: sample.time)
                    began = true
                }
                // The recording's own tick, which the real thing doesn't have.
                if !hapticMuted && sample.time >= release.time + 0.1 {
                    detector.mute(until: release.time + 0.24)
                    hapticMuted = true
                }
                let change = detector.feed(acceleration: sample.acceleration, spin: sample.spin, at: sample.time)
                if began && change == .apart {
                    ended = sample.time
                    break
                }
            }
            if let ended {
                if ended < release.time - 0.05 { result.early += 1 } else { result.caught += 1 }
            } else {
                result.missed += 1
            }
        }
        return result
    }
    let moving = "pinch-recording-moving.csv"
    let first = "pinch-recording.csv"
    let (normal, slow, steady, still, vigorous) = (holds(moving, "letgo"), holds(moving, "slow"), holds(moving, "steady"), holds(first, "hold"), holds(first, "move"))
    print("  mid-drag replay: normal \(normal), slow \(slow), steady \(steady), still \(still), vigorous \(vigorous)")
    check(normal.caught >= 4, "at normal speed, most releases are felt without stopping (\(normal))")
    check(normal.early <= 1, "and a drag rarely drops by itself (\(normal))")
    check(slow.caught >= 2 && slow.early == 0, "moving slowly, the arm is quiet enough to feel a gentle one (\(slow))")
    check(still.caught == 5, "still, every release is felt, as before (\(still))")
    check(vigorous.caught >= 3 && vigorous.early <= 1, "and swinging hard doesn't throw it (\(vigorous))")
}

// Teaching: the threshold comes from your pinches and the still hand.
do {
    var teacher = PinchTeacher()
    var time = 0.0
    let feed = { (t: inout PinchTeacher, a: SIMD3<Double>) in
        t.feed(acceleration: a, at: time)
        time += 0.01
    }
    for i in 0..<200 { feed(&teacher, SIMD3(i % 2 == 0 ? 0.002 : 0, 0, 0)) }
    check(teacher.stillDone, "past the still moment")
    check(teacher.result == nil, "no pinches, nothing learned")
    for strength in [0.5, 0.3, 0.4, 0.45, 0.35] {
        feed(&teacher, SIMD3(strength, 0, 0))
        for _ in 0..<60 { feed(&teacher, .zero) }
    }
    check(teacher.peaks.count >= PinchTeacher.pinches, "five pinches heard (\(teacher.peaks.count))")
    if let learned = teacher.result {
        check(learned > 0.1 && learned < 0.3, "the threshold sits under the pinches (\(learned))")
        var detector = PinchDetector(learned: learned)
        check(run(&detector, [.zero, SIMD3(0.4, 0, 0), .zero, .zero, .zero, .zero]).count == 1, "and hears the next one")
    } else {
        check(false, "learned nothing")
    }

    var noisy = PinchTeacher()
    time = 0
    for i in 0..<200 { feed(&noisy, SIMD3(i % 2 == 0 ? 0.1 : 0, 0, 0)) }
    for _ in 0..<PinchTeacher.pinches {
        feed(&noisy, SIMD3(0.2, 0, 0))
        for _ in 0..<60 { feed(&noisy, .zero) }
    }
    check(noisy.result == nil, "pinches no stronger than the shaking hand teach nothing")
}

print("\(checks - failures)/\(checks) checks passed")
exit(failures == 0 ? 0 : 1)
