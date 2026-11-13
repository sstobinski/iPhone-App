import Foundation

struct ConnectionLink {
    let url: URL
    static func parse(_ text: String) -> ConnectionLink? {
        guard text.utf8.count <= 2048 else { return nil }
        guard var parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme?.lowercased() == "http", parts.user == nil, parts.password == nil,
              let host = parts.host, let port = parts.port, (1...65535).contains(port),
              parts.path.isEmpty || parts.path == "/", parts.query == nil,
              let fragment = parts.fragment, fragment.hasPrefix("key=") else { return nil }
        let fields = host.split(separator: ".", omittingEmptySubsequences: false)
        guard fields.count == 4 else { return nil }
        let octets = fields.compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }),
              zip(fields, octets).allSatisfy({ String($0.0) == String($0.1) }) else { return nil }
        let local = octets[0] == 10 || octets[0] == 192 && octets[1] == 168
            || octets[0] == 172 && (16...31).contains(octets[1])
            || octets[0] == 169 && octets[1] == 254
            || octets[0] == 100 && (64...127).contains(octets[1])
        guard local else { return nil }
        let token = String(fragment.dropFirst(4))
        guard token.range(of: "^[A-Za-z0-9_-]{24,128}$", options: .regularExpression) != nil else { return nil }
        parts.path = "/"
        guard let url = parts.url else { return nil }
        return ConnectionLink(url: url)
    }
    
    func allowsRequest(to candidate: URL) -> Bool {
        guard let from = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let to = URLComponents(url: candidate, resolvingAgainstBaseURL: false) else { return false }
        return from.scheme == to.scheme && from.host == to.host && from.port == to.port
            && to.user == nil && to.password == nil && to.fragment == nil
            && ["/api/state", "/api/frame", "/api/client-metrics"].contains(to.path)
    }
}
