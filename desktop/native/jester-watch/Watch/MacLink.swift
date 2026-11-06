import CoreBluetooth
import CryptoKit
import Foundation

/// The Bluetooth link to Jester on the Mac: finding it, pairing, and carrying
/// motion frames. Everything here runs on the main queue.
final class MacLink: NSObject, ObservableObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    enum Status {
        case bluetoothOff, searching, connecting, ready
    }

    @Published private(set) var status = Status.searching
    @Published private(set) var paired = Keychain.load() != nil
    @Published private(set) var code: String?
    @Published private(set) var pairingNow = false
    @Published private(set) var note: String?

    private var central: CBCentralManager!
    private var mac: CBPeripheral?
    private var toMac: CBCharacteristic?
    private var session: WatchSession?
    private var pairing: WatchPairing?
    private var outbox: [Data] = []

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: nil)
    }

    var canSendMotion: Bool { session != nil && toMac != nil && mac?.canSendWriteWithoutResponse == true }

    func click() {
        session?.click()
    }

    func sendMotion(yaw: Int16, pitch: Int16, milliseconds: UInt8, steering: Bool, held: Bool = false, whole: Bool = false) {
        guard let frame = session?.frame(yaw: yaw, pitch: pitch, milliseconds: milliseconds, steering: steering, held: held, whole: whole),
              let mac, let toMac else { return }
        mac.writeValue(frame, for: toMac, type: .withoutResponse)
    }

    func startPairing() {
        note = nil
        code = nil
        pairingNow = true
        pairing = WatchPairing()
        if toMac != nil, let frames = pairing?.opening() { send(frames) } else { search() }
    }

    func cancelPairing() {
        pairing = nil
        pairingNow = false
        code = nil
    }

    private func send(_ frames: [Data]) {
        outbox += frames
        pump()
    }

    private func pump() {
        while let next = outbox.first, let mac, let toMac, mac.canSendWriteWithoutResponse {
            mac.writeValue(next, for: toMac, type: .withoutResponse)
            outbox.removeFirst()
        }
    }

    /// Unpaired, there's no one to look for until you ask.
    private func search() {
        guard central.state == .poweredOn, paired || pairing != nil, !central.isScanning, mac == nil else { return }
        status = .searching
        central.scanForPeripherals(withServices: [CBUUID(string: Wire.service)])
    }

    private func lost() {
        mac = nil
        toMac = nil
        session = nil
        outbox = []
        if central.state == .poweredOn { status = .searching }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.search() }
    }

    private func hear(_ frame: Data) {
        switch frame.kind {
        case .challenge:
            guard let raw = Keychain.load() else { return }
            session = WatchSession(key: SymmetricKey(data: raw), opening: frame)
            status = .ready
            note = nil
            // Proves itself at once: a Mac that has forgotten this watch says so now.
            if canSendMotion { sendMotion(yaw: 0, pitch: 0, milliseconds: 1, steering: false) }
        case .macKey:
            guard var current = pairing else { return }
            let replies = current.receive(frame)
            pairing = current
            code = current.code
            send(replies)
        case .paired:
            guard let current = pairing, current.confirmed(by: frame), let key = current.key else { return }
            Keychain.save(key.raw)
            paired = true
            cancelPairing()
        case .notPairing:
            cancelPairing()
            note = "Click Pair in Jester’s Settings first"
        case .unknownWatch:
            note = "Jester doesn’t know this watch. Pair again."
        default:
            break
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn {
            search()
        } else {
            status = .bluetoothOff
            mac = nil
            toMac = nil
            session = nil
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) {
        central.stopScan()
        mac = peripheral
        peripheral.delegate = self
        status = .connecting
        central.connect(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices([CBUUID(string: Wire.service)])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        lost()
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        lost()
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = peripheral.services?.first else { return central.cancelPeripheralConnection(peripheral) }
        peripheral.discoverCharacteristics([CBUUID(string: Wire.toMac), CBUUID(string: Wire.toWatch)], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        toMac = service.characteristics?.first { $0.uuid == CBUUID(string: Wire.toMac) }
        guard toMac != nil, let toWatch = service.characteristics?.first(where: { $0.uuid == CBUUID(string: Wire.toWatch) }) else {
            return central.cancelPeripheralConnection(peripheral)
        }
        peripheral.setNotifyValue(true, for: toWatch)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        if let frames = pairing?.opening(), error == nil { send(frames) }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if let value = characteristic.value { hear(value) }
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        pump()
    }
}
