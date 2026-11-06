import SwiftUI

@main
struct JesterWatchApp: App {
    @StateObject private var link: MacLink
    @StateObject private var steer: Steer

    init() {
        let link = MacLink()
        _link = StateObject(wrappedValue: link)
        _steer = StateObject(wrappedValue: Steer(link: link))
    }

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                if steer.on {
                    SteeringView()
                } else if link.paired && !link.pairingNow {
                    ReadyView()
                } else {
                    PairView()
                }
            }
            .environmentObject(link)
            .environmentObject(steer)
        }
    }
}

private struct Note: View {
    let text: String?

    var body: some View {
        if let text {
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }
}

struct PairView: View {
    @EnvironmentObject private var link: MacLink

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                if let code = link.code {
                    Text("Same number in Jester?")
                        .font(.footnote)
                    Text(code)
                        .font(.title2.monospacedDigit())
                    Text("Click They match on your Mac.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                } else if link.pairingNow {
                    ProgressView()
                    Text("Finding your Mac…")
                        .font(.footnote)
                } else {
                    Text("In Jester’s Settings, click Pair, then:")
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                    Button("Pair") { link.startPairing() }
                }
                if link.pairingNow { Button("Cancel") { link.cancelPairing() } }
                Note(text: link.note)
            }
        }
        .navigationTitle("Jester")
    }
}

struct ReadyView: View {
    @EnvironmentObject private var link: MacLink
    @EnvironmentObject private var steer: Steer

    private var status: String {
        switch link.status {
        case .bluetoothOff: return "Bluetooth is off"
        case .searching: return "Looking for your Mac…"
        case .connecting: return "Connecting…"
        case .ready: return "Connected"
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                Text(status)
                    .font(.footnote)
                Button("Start") { steer.start() }
                    .disabled(link.status != .ready)
                    .tint(.green)
                Note(text: steer.note ?? link.note)
                NavigationLink("Teach my pinch") { TeachView() }
                if steer.pinchTaught {
                    Button("Pinch: \(steer.ease.name)") { steer.changeEase() }
                    NavigationLink(steer.kindsTaught ? "Teach window move again" : "Teach window move") { TeachKindsView() }
                } else {
                    Note(text: "Until then, click with the button here.")
                }
                NavigationLink("Test pinch and hold") { LabView() }
                Button("Pair again") { link.startPairing() }
            }
        }
        .navigationTitle("Jester")
        .onAppear { steer.checkPinch() }
    }
}

struct SteeringView: View {
    @EnvironmentObject private var link: MacLink
    @EnvironmentObject private var steer: Steer

    var body: some View {
        VStack(spacing: 6) {
            Button { steer.tapped() } label: {
                VStack(spacing: 2) {
                    Text("Click")
                        .font(.title3)
                    Text("Hold to drag")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .buttonStyle(Pressing { steer.press($0) })
            .doubleTapClicks()
            Button("Stop") { steer.stop() }
                .tint(.red)
            Note(text: link.status == .ready ? link.note : "Lost your Mac…")
        }
        .navigationTitle("Steering")
    }
}

/// Says when a finger lands and lifts, not just that it tapped: a button that's
/// held is a mouse button that's held.
private struct Pressing: ButtonStyle {
    let changed: (Bool) -> Void

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Rectangle())
            .background(RoundedRectangle(cornerRadius: 14).fill(.blue.opacity(configuration.isPressed ? 0.7 : 0.35)))
            .onChange(of: configuration.isPressed) { _, pressed in changed(pressed) }
    }
}

private extension View {
    /// Double Tap (Series 9, Ultra 2 and later) presses this while the screen is on.
    @ViewBuilder func doubleTapClicks() -> some View {
        if #available(watchOS 11, *) {
            handGestureShortcut(.primaryAction)
        } else {
            self
        }
    }
}

struct TeachView: View {
    @StateObject private var teach = Teach()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 8) {
            if teach.done {
                Text("Learned")
                    .font(.headline)
                Text("Strength \(teach.strength, specifier: "%.2f")")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Done") { dismiss() }
            } else if teach.still {
                Text("Hold your hand still…")
            } else {
                Text("Tap thumb to finger, as you would to click, with a pause between")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                Text("\(teach.heard) of \(PinchTeacher.pinches)")
                    .font(.title3.monospacedDigit())
            }
        }
        .onAppear { teach.start() }
        .onDisappear { teach.stop() }
    }
}
