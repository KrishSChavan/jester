import CryptoKit
import Foundation

/// What the watch and the Mac say to each other over Bluetooth.
///
/// Bluetooth reaches the next room, and this link moves a cursor and clicks,
/// so nothing it carries is believed unproven. The two pair once: each sends a
/// public key, and both show a code derived from the keys, which you compare
/// and confirm on the Mac. The watch commits to its key before it sees the
/// Mac's, so someone in between can't pick a key that makes the codes agree.
/// After that, every motion frame is signed with the shared key over a
/// challenge the Mac chose for this connection, with a counter that only goes
/// up, so frames can't be forged or replayed.
enum Wire {
    static let service = "BBD679D4-77EA-4726-9D18-A8E65DE62B63"
    /// Written by the watch, without a response.
    static let toMac = "4EBCAED3-14B2-461B-BF39-E0820AD462C4"
    /// Notified by the Mac.
    static let toWatch = "DA1AA753-EA59-44C4-B80C-75DB1B2B4FA6"
    /// What every Bluetooth link can carry in one write.
    static let frameSize = 20
}

enum Kind: UInt8 {
    case commit = 1
    case macKey
    case watchKey
    case paired
    case notPairing
    case challenge
    case unknownWatch
    case motion
}

/// A key is too long for one frame: `[kind, index, count, bytes…]`.
enum Frames {
    private static let header = 3

    static func split(_ kind: Kind, _ blob: Data) -> [Data] {
        let room = Wire.frameSize - header
        let bytes = [UInt8](blob)
        let count = (bytes.count + room - 1) / room
        return (0..<count).map { index in
            let part = bytes[(index * room)..<min(bytes.count, (index + 1) * room)]
            return Data([kind.rawValue, UInt8(index), UInt8(count)] + part)
        }
    }

    /// Collects a split value; the whole of it once the last part has arrived.
    struct Assembly {
        private var parts: [UInt8: [UInt8]] = [:]

        mutating func add(_ frame: Data) -> Data? {
            let bytes = [UInt8](frame)
            guard bytes.count > Frames.header else { return nil }
            parts[bytes[1]] = Array(bytes[Frames.header...])
            let count = bytes[2]
            guard parts.count >= Int(count) else { return nil }
            let whole = (0..<count).compactMap { parts[$0] }
            parts = [:]
            return whole.count == Int(count) ? Data(whole.joined()) : nil
        }
    }
}

extension Data {
    var kind: Kind? { first.flatMap(Kind.init) }
}

private func sign(_ key: SymmetricKey, _ label: String, _ bytes: Data, length: Int) -> Data {
    Data(HMAC<SHA256>.authenticationCode(for: Data(label.utf8) + bytes, using: key)).prefix(length)
}

private func same(_ a: Data, _ b: Data) -> Bool {
    a.count == b.count && zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
}

private func randomBytes(_ count: Int) -> Data {
    SymmetricKey(size: SymmetricKeySize(bitCount: count * 8)).withUnsafeBytes { Data($0) }
}

private enum Pairing {
    static func key(own: Curve25519.KeyAgreement.PrivateKey, theirs: Data, watchKey: Data, macKey: Data) -> SymmetricKey? {
        guard let peer = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: theirs),
              let secret = try? own.sharedSecretFromKeyAgreement(with: peer) else { return nil }
        return secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: watchKey + macKey, sharedInfo: Data("jester-watch-1".utf8), outputByteCount: 32)
    }

    /// Six digits, the same on both screens only if both hold the same key.
    static func code(_ key: SymmetricKey) -> String {
        let number = sign(key, "code", Data(), length: 4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        return String(format: "%06u", number % 1_000_000)
    }

    static func proof(_ key: SymmetricKey) -> Data {
        sign(key, "paired", Data(), length: 16)
    }
}

/// The watch's side of pairing.
struct WatchPairing {
    private let own = Curve25519.KeyAgreement.PrivateKey()
    private var macKey = Frames.Assembly()
    private(set) var key: SymmetricKey?
    private(set) var code: String?

    func opening() -> [Data] {
        Frames.split(.commit, Data(SHA256.hash(data: own.publicKey.rawRepresentation)))
    }

    /// Hears the Mac's key out; what to send back, once it has all of it.
    mutating func receive(_ frame: Data) -> [Data] {
        guard frame.kind == .macKey, key == nil, let theirs = macKey.add(frame) else { return [] }
        let mine = own.publicKey.rawRepresentation
        guard let shared = Pairing.key(own: own, theirs: theirs, watchKey: mine, macKey: theirs) else { return [] }
        key = shared
        code = Pairing.code(shared)
        return Frames.split(.watchKey, mine)
    }

    /// Whether this is the Mac saying you confirmed the codes.
    func confirmed(by frame: Data) -> Bool {
        guard frame.kind == .paired, let key else { return false }
        return same(frame.dropFirst(), Pairing.proof(key))
    }
}

/// The Mac's side of pairing, for as long as you've asked it to pair.
struct MacPairing {
    private let own = Curve25519.KeyAgreement.PrivateKey()
    private var commitment = Frames.Assembly()
    private var watchKey = Frames.Assembly()
    private var committed: Data?
    private(set) var key: SymmetricKey?
    private(set) var code: String?
    /// The watch's key wasn't the one it committed to, or wasn't a key.
    private(set) var failed = false

    /// Hears the watch out; what to send back, if anything. `code` appears
    /// once there's one to compare.
    mutating func receive(_ frame: Data) -> [Data] {
        switch frame.kind {
        case .commit where committed == nil:
            guard let whole = commitment.add(frame) else { return [] }
            committed = whole
            return Frames.split(.macKey, own.publicKey.rawRepresentation)
        case .watchKey where committed != nil && key == nil:
            guard let theirs = watchKey.add(frame), let committed else { return [] }
            let mine = own.publicKey.rawRepresentation
            guard same(Data(SHA256.hash(data: theirs)), committed),
                  let shared = Pairing.key(own: own, theirs: theirs, watchKey: theirs, macKey: mine) else {
                failed = true
                return []
            }
            key = shared
            code = Pairing.code(shared)
            return []
        default:
            return []
        }
    }

    /// You said the codes match: the frame that tells the watch so.
    func confirmation() -> Data? {
        key.map { Data([Kind.paired.rawValue]) + Pairing.proof($0) }
    }
}

extension SymmetricKey {
    var raw: Data { withUnsafeBytes { Data($0) } }
}

/// One motion frame, as the Mac believes it.
struct Report: Equatable {
    /// Turned right and tipped up since the last frame, in ten-thousandths of a radian.
    var yaw: Int16
    var pitch: Int16
    /// How long that took: speed decides how far it moves the cursor.
    var milliseconds: UInt8
    var steering: Bool
    var click: Bool
    /// The Click button is pressed, or thumb and finger are together: the mouse button, held.
    var held = false
    /// That press is all fingers: a hold carries the window, not what's under the cursor.
    var whole = false
}

/// `[kind, counter×4, yaw×2, pitch×2, ms, flags, clicks, tag×8]`: exactly one frame.
private enum Layout {
    static let signed = 12
    static let total = signed + 8
    static let label = "motion"
}

private func int16(_ value: Int16) -> [UInt8] {
    let bits = UInt16(bitPattern: value)
    return [UInt8(bits & 0xff), UInt8(bits >> 8)]
}

private func int16(_ low: UInt8, _ high: UInt8) -> Int16 {
    Int16(bitPattern: UInt16(high) << 8 | UInt16(low))
}

/// One connection, on the watch.
struct WatchSession {
    let key: SymmetricKey
    let challenge: Data
    private var counter: UInt32 = 0
    /// Sent with every frame, so a click survives a lost one and can't happen twice.
    private(set) var clicks: UInt8 = 0

    init(key: SymmetricKey, opening frame: Data) {
        self.key = key
        challenge = frame.dropFirst()
    }

    mutating func click() {
        clicks &+= 1
    }

    mutating func frame(yaw: Int16, pitch: Int16, milliseconds: UInt8, steering: Bool, held: Bool = false, whole: Bool = false) -> Data {
        counter += 1
        let c = counter
        var bytes: [UInt8] = [Kind.motion.rawValue, UInt8(c & 0xff), UInt8(c >> 8 & 0xff), UInt8(c >> 16 & 0xff), UInt8(c >> 24)]
        bytes += int16(yaw) + int16(pitch)
        bytes += [milliseconds, (steering ? 1 : 0) | (held ? 2 : 0) | (whole ? 4 : 0), clicks]
        let body = Data(bytes)
        return body + sign(key, Layout.label, challenge + body, length: Layout.total - Layout.signed)
    }
}

/// One connection, on the Mac.
struct MacSession {
    let key: SymmetricKey?
    private let challenge = randomBytes(16)
    private var counter: UInt32 = 0
    private var clicks: UInt8 = 0

    init(key: SymmetricKey?) {
        self.key = key
    }

    /// Sent as the connection opens: every frame after it signs these bytes.
    var opening: Data { Data([Kind.challenge.rawValue]) + challenge }

    /// What a motion frame reported, or nil if it isn't to be believed.
    mutating func receive(_ frame: Data) -> Report? {
        let bytes = [UInt8](frame)
        guard let key, frame.kind == .motion, bytes.count == Layout.total else { return nil }
        let body = Data(bytes[..<Layout.signed])
        guard same(Data(bytes[Layout.signed...]), sign(key, Layout.label, challenge + body, length: Layout.total - Layout.signed)) else { return nil }
        let sent = UInt32(bytes[1]) | UInt32(bytes[2]) << 8 | UInt32(bytes[3]) << 16 | UInt32(bytes[4]) << 24
        guard sent > counter else { return nil }
        counter = sent
        let click = bytes[11] != clicks
        clicks = bytes[11]
        return Report(yaw: int16(bytes[5], bytes[6]), pitch: int16(bytes[7], bytes[8]), milliseconds: bytes[9], steering: bytes[10] & 1 != 0, click: click, held: bytes[10] & 2 != 0, whole: bytes[10] & 4 != 0)
    }
}
