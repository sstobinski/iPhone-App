# Serato Companion

Native iPhone-Anzeige für den freigegebenen Wellenformausschnitt aus Serato DJ Pro. Die App verwendet SwiftUI und UIKit/ImageIO. Die Wellenformen kommen als fertig gezeichnete Bilder vom Mac; ein eigener Audio-Wellenform-Renderer ist nicht enthalten. Tracktitel, Interpret und BPM kommen über den separaten lokalen Statuskanal.

Dieses Repository enthält nun beide Teile: das bestehende Xcode-Projekt im Hauptordner und den Mac-Helfer im Ordner **Mac-Helfer**. Der Funktionsstand entspricht der Testfassung **0.1.13**. Die bereits eingerichteten Projekt-, Signing-, Bundle-Identifier- und Scheme-Einstellungen wurden bei der Übernahme beibehalten.

## Starten

1. Auf dem Mac **Mac-Helfer/Start-Fenster-Test.command** starten. Der Standard bleibt ein Aufnahmeziel von 60 FPS; **Start-30-FPS.command** dient zum Vergleich. Auflösung, JPEG-Qualität und Serato-Bereichserkennung bleiben erhalten.
2. **WaveCompanion.xcodeproj** öffnen oder **Start-iPhone-App.command** starten. In Xcode das eigene iPhone auswählen und **Run** drücken. Das vorhandene Personal Team verwenden.
3. In der iPhone-App den aktuellen QR-Code der Mac-Einrichtungsseite scannen. Mac und iPhone müssen im selben lokalen Netzwerk erreichbar sein. Kamera- und lokale Netzwerkberechtigung auf dem iPhone erlauben.
4. Für Seratos horizontale Ansicht das iPhone im Querformat verwenden, für die vertikale Ansicht im Hochformat.

Der Mac-Helfer benötigt macOS, Node.js ab Version 22, die lokalen Apple-Compilerwerkzeuge und die Bildschirmaufnahmeberechtigung. Die native iPhone-App benötigt weder eine WebView noch MIDI- oder Musikbibliothekszugriff. Die Metadatenanbindung ist ein inoffizieller Serato-Statuskanal und keine öffentliche SDK-Zusage.

## Aktuelle Änderung am Bildabruf

Die iPhone-App wartet nach einem gültigen Bild nicht zusätzlich auf einen eigenen 30-/60-Hz-Takt. Der Mac und die wartende Bildanfrage bestimmen bereits den Takt. Es laufen weiterhin nur ein Bildabruf und eine Hintergrunddekodierung gleichzeitig. Eine Sicherheitsgrenze von 120 Anfragen/s bei sofortigen Antworten hebt das Aufnahmeziel nicht auf 120 FPS an. Fehler und unveränderte Antworten erhalten eine Mindestpause.

Der neue Mac-Helfer kündigt Messprotokollversion 2 an. Damit meldet die App zusätzlich sichtbare Zeit und Bildübergaben während frischer Serato-Bewegungsdaten. Im Bericht stehen sie unter **transport.clientPerformance[].movingPlayback**, getrennt vom Gesamtmittel. Die Zuordnung basiert auf der Abspielgeschwindigkeit, ist höchstens 500 ms gültig und kann Rückwärtslauf und Scratch-Bewegungen einschließen. Hintergrundzeit und Zeit ohne sichtbares Bild werden nicht gezählt. Fehlende Daten erzeugen keinen erfundenen 0-FPS-Wert. Es handelt sich um selbst gemeldete UIKit-Übergaben, nicht um physisch gemessene Displaywechsel oder Ende-zu-Ende-Latenz.

Eine höhere tatsächlich erreichte Bildrate ist mit diesem Stand noch auf dem iPhone zu prüfen. Ältere Clients bleiben am neuen Helfer verwendbar; die neue App kann den vorherigen Helfer weiterhin nutzen, dort ohne die zusätzliche Bewegungsmessung.

## Kurzer Vergleichstest

Zwei Tracks laden, ungefähr **30 Sekunden abspielen, 10 Sekunden pausieren und weitere 30 Sekunden abspielen**. Danach im Mac-Terminal **q und Enter** drücken. **Mac-Helfer/window-report.json** enthält das Gesamtmittel und den zusätzlichen Bewegungswert. Der Bericht gehört nicht ins Repository und wird von Git ignoriert.

## Prüfungen

- **cd Mac-Helfer && npm test**: 150 Node-Tests für Protokoll, Bilderkennung, Transport, Metadaten und Messwerte.
- **Product → Test / Cmd+U** in Xcode: acht native XCTest-Fälle für Verbindungslinks, Frame-Zuordnung, Abrufabstand und Bewegungszähler. Bei Simulatorprüfungen ist keine Gerätesignierung nötig; für Gerätetests das vorhandene Personal Team verwenden.
- Die Swift-Syntax und Projektstruktur wurden unter Linux geprüft. Xcode, iOS-SDK-Build, native XCTest-Ausführung und der tatsächliche FPS-Vergleich sind hier nicht verfügbar und müssen auf dem Mac erfolgen.

Die ausführliche Mac-Diagnostik und Drittanbieterhinweise stehen im Ordner **Mac-Helfer**. Die kostenlose Apple-ID reicht für Tests auf dem eigenen iPhone; die Signierung ist üblicherweise sieben Tage gültig.
