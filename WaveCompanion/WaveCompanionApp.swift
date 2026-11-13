import SwiftUI
import UIKit

@main
@MainActor
struct WaveCompanionApp: App {
    var body: some Scene { WindowGroup { CompanionView().preferredColorScheme(.dark) } }
}

@MainActor
struct CompanionView: View {
    @State private var link = SavedConnection.load()
    @State private var input = ""
    @State private var scanning = false
    @State private var errorMessage: String?
    var body: some View {
        ZStack {
            Color(red: 0.035, green: 0.055, blue: 0.08).ignoresSafeArea()
            if let link = link {
                LiveDisplay(link: link)
                    .id(link.url)
                    .overlay(alignment: .bottomTrailing) {
                        Button { disconnect() } label: {
                            Image(systemName: "qrcode").font(.system(size: 19, weight: .semibold))
                                .frame(width: 44, height: 44).background(.ultraThinMaterial, in: Circle())
                        }.accessibilityLabel("Neue Mac-Verbindung öffnen").padding(12)
                    }
                    .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
                    .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        Image(systemName: "waveform").font(.system(size: 46)).foregroundStyle(.cyan)
                        Text("Wave Companion").font(.largeTitle.bold())
                        Text("Mac-Helfer starten. Danach den QR-Code der Mac-Einrichtungsseite scannen.")
                            .foregroundStyle(.secondary)
                        Button { scanning = true } label: { Label("Mac-QR-Code scannen", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity) }
                            .buttonStyle(.borderedProminent).tint(.cyan).foregroundStyle(.black)
                        TextField("Verbindungslink vom Mac", text: $input).textInputAutocapitalization(.never)
                            .autocorrectionDisabled().keyboardType(.URL).textFieldStyle(.roundedBorder)
                            .privacySensitive()
                        HStack {
                            Button("Link einfügen") { input = UIPasteboard.general.string ?? "" }
                            Spacer(); Button("Verbinden") { connect(input) }.buttonStyle(.bordered)
                        }
                        Text("Mac und iPhone müssen im selben WLAN sein. Der Mac-Helfer bleibt während der Nutzung geöffnet.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }.padding(28).frame(maxWidth: 570)
                }
            }
        }
        .statusBarHidden(link != nil)
        .fullScreenCover(isPresented: $scanning) {
            ZStack(alignment: .topTrailing) {
                QRScanner(found: { value in scanning = false; connect(value) }, failure: { value in scanning = false; errorMessage = value })
                    .ignoresSafeArea()
                Button("Abbrechen") { scanning = false }.buttonStyle(.borderedProminent).padding(22)
            }
        }
        .alert("Verbindung prüfen", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
            Button("Neue Verbindung") { disconnect() }; Button("Schließen", role: .cancel) { errorMessage = nil }
        } message: { Text(errorMessage ?? "") }
    }
    
    private func connect(_ value: String) {
        guard let next = ConnectionLink.parse(value) else {
            errorMessage = "Bitte den aktuellen iPhone-QR-Code oder vollständigen lokalen Verbindungslink aus dem Mac-Helfer verwenden."; return
        }
        input = ""; errorMessage = nil; SavedConnection.save(next); link = next
    }
    
    private func disconnect() { SavedConnection.clear(); link = nil; errorMessage = nil; UIApplication.shared.isIdleTimerDisabled = false }
}
