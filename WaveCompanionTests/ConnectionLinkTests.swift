import Foundation
import XCTest
@testable import WaveCompanion

final class ConnectionLinkTests: XCTestCase {
    private let token = String(repeating: "a", count: 32)
    func testLocalConnectionAndOrigin() throws {
        let link = try XCTUnwrap(ConnectionLink.parse("http://192.168.68.68:51234/#key=\(token)"))
        XCTAssertFalse(link.allowsRequest(to: link.url))
        XCTAssertTrue(link.allowsRequest(to: URL(string: "http://192.168.68.68:51234/api/state")!))
        XCTAssertFalse(link.allowsRequest(to: URL(string: "http://192.168.68.69:51234/")!))
        XCTAssertFalse(link.allowsRequest(to: URL(string: "http://192.168.68.68:51235/")!))
        XCTAssertFalse(link.allowsRequest(to: URL(string: "https://192.168.68.68:51234/")!))
        XCTAssertFalse(link.allowsRequest(to: URL(string: "http://192.168.68.68:51234/api/source")!))
        XCTAssertTrue(link.allowsRequest(to: URL(string: "http://192.168.68.68:51234/api/frame?after=12&wait=1")!))
    }
    func testRejectsPublicLoopbackMalformedAndCredentialURLs() {
        for host in ["127.0.0.1", "8.8.8.8", "0.0.0.0", "192.168.1.999", "example.com", "192.168.01.1"] {
            XCTAssertNil(ConnectionLink.parse("http://\(host):51234/#key=\(token)"))
        }
        for text in ["https://192.168.1.1:51234/#key=\(token)", "http://u:p@192.168.1.1:51234/#key=\(token)",
            "http://192.168.1.1:51234/?key=\(token)", "http://192.168.1.1:51234/path#key=\(token)",
            "http://192.168.1.1:51234/#key=short", "http://192.168.1.1:51234/#key=\(token)&other=1"] {
            XCTAssertNil(ConnectionLink.parse(text))
        }
    }
}

final class NativeProtocolTests: XCTestCase {
    private func state(crop: Int = 2) throws -> DisplayState {
        let json = """
        {"mode":"live","native":{"status":"capture-ready"},"transfer":{"enabled":true,"status":"live","geometryRevision":1,"cropRevision":\(crop),"ageMs":0,"unchanged":false},"trackInfo":{"status":"connected","decks":[{"id":1,"title":"Local Track","artist":"Artist","bpm":86.2}]},"performance":{"targetFps":60}}
        """
        return try JSONDecoder().decode(DisplayState.self, from: Data(json.utf8))
    }
    func testFrameCannotSurviveCropChangeOrDuplicateSequence() throws {
        let response = try XCTUnwrap(HTTPURLResponse(url: URL(string: "http://192.168.1.1:5000/api/frame")!, statusCode: 200,
            httpVersion: nil, headerFields: ["X-Frame-Sequence":"12","X-Frame-Geometry":"1","X-Frame-Crop":"2"]))
        let frame = try XCTUnwrap(FrameIdentity(response: response))
        XCTAssertTrue(frame.isOwned(by: try state(), after: 11))
        XCTAssertFalse(frame.isOwned(by: try state(), after: 12))
        XCTAssertFalse(frame.isOwned(by: try state(crop: 3), after: 11))
        XCTAssertFalse(frame.isOwned(by: nil, after: 11))
    }
    func testMetadataPayloadAndMalformedFrameHeaders() throws {
        let value = try state(); XCTAssertEqual(value.trackInfo?.decks.first?.bpm, 86.2)
        for sequence in ["0","01","-1","1.5","9007199254740992"] {
            let response = try XCTUnwrap(HTTPURLResponse(url: URL(string: "http://192.168.1.1:5000/api/frame")!, statusCode: 200,
                httpVersion: nil, headerFields: ["X-Frame-Sequence":sequence,"X-Frame-Geometry":"1","X-Frame-Crop":"2"]))
            XCTAssertNil(FrameIdentity(response: response))
        }
    }
}
