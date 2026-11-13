# Wave Companion – erster iPhone-App-Prototyp

Die iPhone-App verwendet **SwiftUI für Oberfläche und Trackkarten** sowie **UIImageView/Core Animation für die Bildanzeige**. JPEG-Bilder werden mit ImageIO im Hintergrund dekodiert. Verbindung, HTTP-Abrufe, Statusauswertung und QR-Scanner sind in Swift umgesetzt. Es gibt keine WebView und keine Browseroberfläche in der App.

Die App zeigt Seratos fertig gezeichnete Wellenformbilder. Es wird kein eigener Wellenform-Renderer aus Audiodaten und keine neue Cue-/Quantize-Berechnung eingebaut. Der Mac-Helfer aus dem übergeordneten Ordner bleibt erforderlich und liefert den freigegebenen Ausschnitt sowie die Trackdaten.

**Build-Grenze:** Das vollständige Xcode-Projekt und vier XCTest-Fälle für Verbindungslinks und Frame-Zuordnung liegen bei. Die Projektstruktur, XML-Dateien und Quelltexte wurden unter Linux geprüft. Apple-SDKs und Xcode stehen dort nicht zur Verfügung. Die iPhone-App ist hier noch nicht kompiliert, signiert oder auf einem Gerät ausgeführt worden. Es liegt keine fertige installierbare IPA oder TestFlight-Version vor. Die Browserprüfung betrifft ausschließlich die weiterhin vorhandene Web-Ausweichanzeige; sie ersetzt den nativen iPhone-Build nicht.

## Einmal auf dem eigenen iPhone installieren

1. Auf dem Mac **Start-iPhone-App.command** doppelklicken. Alternativ **WaveCompanion.xcodeproj** in diesem Ordner mit Xcode öffnen.
2. In Xcode unter **Settings → Accounts** die eigene Apple-ID hinzufügen, sofern noch nicht vorhanden. Eine kostenlose Apple-ID mit **Personal Team** reicht für diesen Gerätetest.
3. Links das blaue **WaveCompanion**-Projekt auswählen. Unter **TARGETS → WaveCompanion → Signing & Capabilities** **Automatically manage signing** aktivieren und das eigene **Personal Team** auswählen.
4. Den **Bundle Identifier** durch einen eigenen eindeutigen Namen ersetzen, beispielsweise `de.deinname.WaveCompanion`. Xcode darf ihn nicht als bereits vergeben melden.
5. Das iPhone per USB verbinden, am iPhone dem Mac vertrauen und oben in Xcode als Zielgerät das **eigene iPhone** auswählen. Falls iOS es verlangt, unter **Einstellungen → Datenschutz & Sicherheit → Entwicklermodus** aktivieren und die von iOS angezeigten Schritte abschließen.
6. In Xcode oben **▶ Run** drücken. Xcode baut, signiert und installiert die App. Falls iOS die Entwickler-App beim ersten Start noch nicht freigibt, den von iOS genannten Eintrag unter **Einstellungen → Allgemein → VPN & Geräteverwaltung** bestätigen.
7. Für die Link- und Frame-Prüfungen kann **Product → Test** beziehungsweise **Cmd+U** verwendet werden. Bei Tests auf dem Gerät auch dem Test-Target das eigene Team zuweisen; alternativ einen iPhone-Simulator als Testziel wählen.

Kostenlose Signierung ist üblicherweise sieben Tage gültig. Danach die App erneut über Xcode installieren. Für TestFlight und App-Store-Verteilung wird später eine bezahlte Apple-Developer-Mitgliedschaft benötigt. Das Projekt ist noch kein für den App Store freigegebenes Produkt. Es sind keine entgeltlichen App-Dienste oder zusätzlichen Swift-Pakete erforderlich.

## Benutzen

1. Auf dem Mac **Start-Fenster-Test.command** aus dieser neuen Fassung starten. Serato öffnen, den automatisch markierten Wellenformausschnitt prüfen und die Tracks laden.
2. Auf dem iPhone **Wave Companion** öffnen und **Mac-QR-Code scannen** wählen. Dafür den QR-Code der Mac-Einrichtungsseite verwenden.
3. Den angefragten Zugriff auf **Kamera** und **lokales Netzwerk** erlauben. Die Kamera dient nur zum Scannen. Ohne Kamera kann der vollständige Verbindungslink über **Link einfügen** eingetragen werden; die Zwischenablage wird nur nach diesem Tippen gelesen.
4. Für Serato **Horizontal** das iPhone ins Querformat drehen; bei **Vertical** Hochformat verwenden.
5. Das kleine QR-Symbol unten rechts öffnet die Verbindungseinrichtung erneut. Wird der Mac-Helfer neu gestartet, dessen neuen QR-Code scannen. Ein alter Link kann nach dem Neustart nicht mehr gültig sein.

Die letzte Verbindung wird nur auf diesem iPhone im Schlüsselbund gespeichert, ohne iCloud-Synchronisierung und mit Gerätebindung. „Neue Verbindung“ entfernt sie. Es gibt keine Anmeldung bei einem Cloud-Dienst und keinen Upload der Wellenformbilder. Der Mac-Link enthält einen Zugangsschlüssel; das Projekt schreibt ihn nicht in Logs. Die Bildübertragung ist lokales HTTP. HTTP-Abrufe bleiben auf die drei benötigten API-Pfade des geprüften lokalen Mac-Ursprungs beschränkt. HTTP-Umleitungen werden abgelehnt. Die ATS-Ausnahme erlaubt dafür lokales HTTP; sie wird durch diese URL-Prüfungen eingegrenzt.

Die App hält während der Anzeige den Bildschirm wach. Sie benötigt weder Mikrofon-, Musikbibliothek- noch MIDI-Zugriff auf dem iPhone. Neue Kopfzeilen zeigen Titel, Interpret soweit vom Statuskanal geliefert und BPM. Die vorhandene Kamera-/Aufnahmeberechtigung am Mac bleibt davon unabhängig.

Wenn Xcode beim Build einen Fehler zeigt, den ersten roten Fehlertext senden. Erst nach diesem echten Xcode-/Gerätetest können wir den nativen App-Stand als lauffähig bestätigen.

## Darstellung und Diagnostik

Der Client übernimmt nur Bilder mit passenden Geometrie-/Crop-Kennungen und neuer Sequenznummer. Diese Bedingungen werden vor und nach der Hintergrunddekodierung geprüft. Ein neuer Bereich, eine pausierte Quelle oder eine veraltete Verbindung verwirft das vorherige Bild. Eine unveränderte, erreichbare Quelle darf ihr Standbild behalten. Im Hintergrund pausieren die Abrufe; beim Zurückkehren wird zuerst der aktuelle Status geprüft.

Es gibt jeweils einen Bildabruf und eine Dekodierung gleichzeitig. UIImageView stellt den neuesten dekodierten Ausschnitt über Apples Compositor dar; es wird keine anwachsende Liste alter Frames aufgebaut. Das Aufnahmeziel bleibt bis zu 60 Bilder/s. Die tatsächlich erreichte native Bildrate muss auf dem iPhone gemessen werden.

Der Leistungsbericht erfasst UIKit-Bildübergaben und lokale Request-/Decode-Zeiten. Das sind selbst gemeldete Zähler und keine Messung physisch dargestellter Bildwechsel oder der gesamten Verzögerung. Die native Render-Wartezeit wird nicht gemessen und als null übertragen. Trackdaten und Bildstrom kommen unabhängig an; ihre Anzeige ist nicht bildgenau miteinander synchronisiert.
