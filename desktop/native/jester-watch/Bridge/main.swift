import CoreBluetooth
import CoreGraphics
import CryptoKit
import Foundation

// Jester's end of the watch's Bluetooth link, as JSON lines over stdio, like
// jester-driver. The Mac has to be the peripheral: a watch can only be a
// central, and Apple keeps sockets on a watch for audio and calls.
//
// In:  {cmd: "start", key?}, {cmd: "pair"}, {cmd: "confirm"}, {cmd: "cancel"}, {cmd: "forget"}
// Out: {event: "bluetooth", state}, {event: "nearby", count}, {event: "code", code},
//      {event: "paired", key}, {event: "pairFailed"}, {event: "stranger"},
//      {event: "motion", yaw, pitch, ms, steering, click, held, whole, typing}
//
// Closing stdin ends it, and with it the advertising.

private func say(_ event: String, _ fields: [String: Any] = [:]) {
    var line = fields
    line["event"] = event
    guard var data = try? JSONSerialization.data(withJSONObject: line) else { return }
    data.append(0x0a)
    FileHandle.standardOutput.write(data)
}

/// Fingers on the keyboard: the wrist is typing, not aiming.
private func typing() -> Bool {
    CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: .keyDown) < 0.8
}

final class Bridge: NSObject, CBPeripheralManagerDelegate {
    private let queue = DispatchQueue(label: "jester.watch")
    private var manager: CBPeripheralManager?
    private var key: SymmetricKey?
    private let toWatch = CBMutableCharacteristic(type: CBUUID(string: Wire.toWatch), properties: .notify, value: nil, permissions: [])
    private let toMac = CBMutableCharacteristic(type: CBUUID(string: Wire.toMac), properties: .writeWithoutResponse, value: nil, permissions: .writeable)
    /// Each central has its own challenge, so a stray one can't disturb the watch's.
    private var sessions: [UUID: MacSession] = [:]
    private var centrals: [UUID: CBCentral] = [:]
    private var pairing: MacPairing?
    private var pairingWith: UUID?
    private var outbox: [(frame: Data, central: CBCentral)] = []
    private var lastStranger = Date.distantPast

    func command(_ line: String) {
        guard let data = line.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cmd = message["cmd"] as? String else { return }
        queue.async { self.run(cmd, message) }
    }

    private func run(_ cmd: String, _ message: [String: Any]) {
        switch cmd {
        case "start":
            if let text = message["key"] as? String, let raw = Data(base64Encoded: text), raw.count == 32 { key = SymmetricKey(data: raw) }
            // Asks for Bluetooth, the first time: only ever because you turned the watch on.
            if manager == nil { manager = CBPeripheralManager(delegate: self, queue: queue) }
        case "pair":
            pairing = MacPairing()
            pairingWith = nil
        case "cancel":
            pairing = nil
            pairingWith = nil
        case "confirm":
            confirm()
        case "forget":
            key = nil
            pairing = nil
            reopen()
        default:
            break
        }
    }

    private func confirm() {
        guard let frame = pairing?.confirmation(), let agreed = pairing?.key, let id = pairingWith, let central = centrals[id] else { return }
        key = agreed
        pairing = nil
        pairingWith = nil
        say("paired", ["key": agreed.raw.base64EncodedString()])
        send(frame, to: central)
        reopen()
    }

    /// The key changed: every connection starts again.
    private func reopen() {
        for (id, central) in centrals {
            let session = MacSession(key: key)
            sessions[id] = session
            send(session.opening, to: central)
        }
    }

    private func send(_ frame: Data, to central: CBCentral) {
        outbox.append((frame, central))
        flush()
    }

    private func flush() {
        while let next = outbox.first {
            guard manager?.updateValue(next.frame, for: toWatch, onSubscribedCentrals: [next.central]) == true else { return }
            outbox.removeFirst()
        }
    }

    private func receive(_ frame: Data, from central: CBCentral) {
        switch frame.kind {
        case .motion:
            let id = central.identifier
            guard let report = sessions[id]?.receive(frame) else { return refuse(central) }
            say("motion", [
                "yaw": Int(report.yaw), "pitch": Int(report.pitch), "ms": Int(report.milliseconds),
                "steering": report.steering, "click": report.click, "held": report.held, "whole": report.whole, "typing": typing()
            ])
        case .commit, .watchKey:
            pair(frame, from: central)
        default:
            break
        }
    }

    /// A frame that proves nothing. If it's your watch, it should hear so.
    private func refuse(_ central: CBCentral) {
        guard Date().timeIntervalSince(lastStranger) > 2 else { return }
        lastStranger = Date()
        say("stranger")
        send(Data([Kind.unknownWatch.rawValue]), to: central)
    }

    private func pair(_ frame: Data, from central: CBCentral) {
        // One watch at a time, and only while you've asked for it.
        guard var current = pairing, pairingWith == nil || pairingWith == central.identifier else {
            return send(Data([Kind.notPairing.rawValue]), to: central)
        }
        pairingWith = central.identifier
        let hadCode = current.code != nil
        let replies = current.receive(frame)
        pairing = current
        for reply in replies { send(reply, to: central) }
        if current.failed {
            pairing = nil
            pairingWith = nil
            say("pairFailed")
        } else if let code = current.code, !hadCode {
            say("code", ["code": code])
        }
    }

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        let states: [CBManagerState: String] = [.poweredOn: "on", .poweredOff: "off", .unauthorized: "denied", .unsupported: "unsupported"]
        say("bluetooth", ["state": states[peripheral.state] ?? "starting"])
        sessions = [:]
        centrals = [:]
        outbox = []
        say("nearby", ["count": 0])
        guard peripheral.state == .poweredOn else { return }
        let service = CBMutableService(type: CBUUID(string: Wire.service), primary: true)
        service.characteristics = [toMac, toWatch]
        peripheral.removeAllServices()
        peripheral.add(service)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error { return say("bluetooth", ["state": "failed", "detail": error.localizedDescription]) }
        peripheral.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [CBUUID(string: Wire.service)],
            CBAdvertisementDataLocalNameKey: "Jester"
        ])
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let error { say("bluetooth", ["state": "failed", "detail": error.localizedDescription]) }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        // Connection intervals are the central's to choose; this asks for short ones.
        peripheral.setDesiredConnectionLatency(.low, for: central)
        let session = MacSession(key: key)
        centrals[central.identifier] = central
        sessions[central.identifier] = session
        send(session.opening, to: central)
        say("nearby", ["count": centrals.count])
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        centrals[central.identifier] = nil
        sessions[central.identifier] = nil
        outbox.removeAll { $0.central.identifier == central.identifier }
        say("nearby", ["count": centrals.count])
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for request in requests {
            if let value = request.value { receive(value, from: request.central) }
        }
    }

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        flush()
    }
}

let bridge = Bridge()
Thread.detachNewThread {
    while let line = readLine() { bridge.command(line) }
    exit(0)
}
dispatchMain()
