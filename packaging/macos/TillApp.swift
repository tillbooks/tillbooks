// TillApp.swift: the native macOS TILL.app (M00, US-M00.2; D166, owner decision 14.10.2026).
//
// WHY A NATIVE WINDOW. Until D166 TILL.app was a stay-open AppleScript applet that started `till up`
// and opened the BARE URL in the default browser. The Studio seat needs a key that is never served
// over HTTP (critic R3-B2), so that tab arrived without it and told a non-technical owner to go and
// find a link in a terminal. The owner's rule: TILL opens by itself, and nobody is sent to a terminal.
//
// HOW THE SEAT GETS IN WITHOUT A TERMINAL, AND WITHOUT THE KEY EVER LEAVING ITS FILE. `till up` keeps
// the Studio key owner-only (0600) in `<support dir>/studio.key` (src/api/studio-key-store.ts). This
// app, running as the same user, reads it and DERIVES a one-time ticket for exactly the running
// `till up`: an HMAC-SHA256 of the key over that process's id (its pid and start time, from the lock)
// and a fresh nonce (src/api/studio-devices.ts, `deriveTicket`). It loads
// `http://127.0.0.1:PORT/#t=<ticket>` in its OWN window. A URL fragment never reaches a server, a
// ticket is spent on first use and is good only for that one process, and the key itself is never in
// a URL, so nothing a squatter on the port, a history entry or a crash report could keep is worth
// anything. The app loads the link only once the lock names the `till up` it started or adopted.
// If the Studio is ever refused later (someone signed out every device), it asks this app through the
// `till` message handler (`rekey`) and the app reloads the window with a fresh ticket.
//
// WHAT IT KEEPS FROM THE APPLET. Double-click starts `till up --no-open` (or ADOPTS a running one on
// the same port and support dir, so Quit still stops it), Quit (Cmd+Q, Dock > Quit, closing the
// window, or a plain `kill` of the app) stops the server: TERM, then KILL after 5 seconds, so no
// `till up` is left on its port.
//
// ADOPTING AN EXISTING BOOK (D166 point 8). The first-run door asks this app for a file through the
// reply-capable `tillPick` handler (a native open panel, nothing else). The server records the book and
// exits 75 (it runs with TILL_SUPERVISED=app), and this app starts it again and reloads the window
// signed in, the same way it brings back any server that went, through the same proof gate as at launch.
// A server that dies on its own is brought back at most once a minute, so one that keeps dying shows
// the stopped page instead of a loop; exit 75 (a restart the person asked for) is not counted.
//
// CONFIGURATION, for an install that is not the default one: an optional `~/.till/app.json` (or the
// file `TILL_APP_CONFIG` names)
//   { "command": "~/.till/run-studio.sh", "port": 8790, "supportDir": "~/.till/books", "logFile": "..." }
// `command` is run through a login shell with `exec`, so a launcher script stays the one source of
// truth for its own environment (a pinned runtime, a bank wire, a Keychain passphrase). Without the
// file: the release build's own Node (`Contents/Resources/runtime/bin/node`) running the bundled
// payload (`Contents/Resources/app/bin/till.mjs`), else the payload on the login shell's `node`, else
// a `till` on the login PATH,
// port 8788, support dir `~/.till`, log `~/Library/Logs/TILL.log`.
//
// The pattern (AppKit + WKWebView, a child server, external links to the system browser) is the one
// the owner's own pendpost.app uses (~/pendpost/packaging/desktop/macos/PendpostApp.swift).
//
// Compiled by packaging/macos/build-macos.sh:  swiftc -O -framework Cocoa -framework WebKit
import Cocoa
import CommonCrypto
import WebKit

// MARK: - language

/// The person's language, for the few words this app shows itself (the Studio has its own i18n).
let german = (Locale.preferredLanguages.first ?? "de").lowercased().hasPrefix("de")
func L(_ de: String, _ en: String) -> String { german ? de : en }

// MARK: - configuration

struct LaunchConfig {
    var command: String?
    var port: Int = 8788
    var supportDir: String = NSHomeDirectory() + "/.till"
    var logFile: String = NSHomeDirectory() + "/Library/Logs/TILL.log"

    static func expand(_ path: String) -> String { (path as NSString).expandingTildeInPath }

    static func load() -> LaunchConfig {
        var config = LaunchConfig()
        // `TILL_APP_CONFIG` points elsewhere (a throwaway test install); the person's file is ~/.till/app.json.
        let file = ProcessInfo.processInfo.environment["TILL_APP_CONFIG"].map(expand) ?? NSHomeDirectory() + "/.till/app.json"
        guard let data = FileManager.default.contents(atPath: file),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return config }
        if let c = json["command"] as? String, !c.isEmpty { config.command = expand(c) }
        if let p = json["port"] as? Int, (1...65535).contains(p) { config.port = p }
        if let s = json["supportDir"] as? String, !s.isEmpty { config.supportDir = expand(s) }
        if let l = json["logFile"] as? String, !l.isEmpty { config.logFile = expand(l) }
        return config
    }

    var baseURL: String { "http://127.0.0.1:\(port)" }
}

// MARK: - the key file

/// The Studio key from `<support dir>/studio.key`, on the same terms `till up` reads it: a plain file
/// (never a symlink), owner-only, base64url of at least 43 characters. Anything else is no key.
func readStudioKey(_ supportDir: String) -> String? {
    let path = supportDir + "/studio.key"
    var st = stat()
    guard lstat(path, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, (st.st_mode & 0o077) == 0,
          st.st_uid == getuid(),
          let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
    let key = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard key.count >= 43, key.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { return nil }
    return key
}

/// What `<support dir>/up.lock` says about the running `till up`, when it names a live process on our
/// port: the pid this app may adopt (and stop on Quit) and the start time a derived ticket must name.
struct LiveLock {
    let pid: pid_t
    let startedAt: String
}

func readLiveLock(_ config: LaunchConfig) -> LiveLock? {
    guard let data = FileManager.default.contents(atPath: config.supportDir + "/up.lock"),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let pid = json["pid"] as? Int, let port = json["port"] as? Int, port == config.port,
          let startedAt = json["startedAt"] as? String else { return nil }
    let p = pid_t(pid)
    return isAlive(p) ? LiveLock(pid: p, startedAt: startedAt) : nil
}

func base64url(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

func hmacSHA256(key: String, message: String) -> Data {
    let secret = Array(key.utf8)
    let bytes = Array(message.utf8)
    var mac = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
    CCHmac(CCHmacAlgorithm(kCCHmacAlgSHA256), secret, secret.count, bytes, bytes.count, &mac)
    return Data(mac)
}

func randomNonce() -> String? {
    var bytes = [UInt8](repeating: 0, count: 18)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
    return base64url(Data(bytes))
}

func instanceId(_ lock: LiveLock) -> String { "\(lock.pid).\(lock.startedAt)" }

/// A one-time ticket for the `till up` named by `lock`, derived from the key exactly as `deriveTicket`
/// in src/api/studio-devices.ts does:
/// `d.<issuedAt ms>.<nonce>.<HMAC-SHA256(key, "till-studio-ticket\n<pid>.<startedAt>\n<issuedAt>\n<nonce>")>`.
func deriveTicket(key: String, lock: LiveLock) -> String? {
    guard let nonce = randomNonce() else { return nil }
    let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
    let mac = hmacSHA256(key: key, message: "till-studio-ticket\n\(instanceId(lock))\n\(issuedAt)\n\(nonce)")
    return "d.\(issuedAt).\(nonce).\(base64url(mac))"
}

/// Does the server answering on the port PROVE it is the `till up` the lock names, holding the key?
/// (critic H1: something answering on the port, plus a lock naming our pid, is not a proof: the lock is
/// written before the port is bound, and another program may hold it.) The server answers a nonce with
/// HMAC(key, "till-studio-server\n<pid>.<startedAt>\n<nonce>"), mirrored from `proofMessage`. Blocking:
/// call it off the main thread.
enum ProofOutcome {
    case proven
    /// A definite no: a wrong proof, a non-200 answer, a refused connection.
    case refused
    /// No answer in time: a busy but real server (a large import is synchronous) looks like this too.
    case inconclusive
}

func proveServer(_ config: LaunchConfig, key: String, lock: LiveLock) -> ProofOutcome {
    guard let nonce = randomNonce(), let url = URL(string: config.baseURL + "/studio/prove") else { return .refused }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.timeoutInterval = 2
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["nonce": nonce])
    let expected = base64url(hmacSHA256(key: key, message: "till-studio-server\n\(instanceId(lock))\n\(nonce)"))
    let done = DispatchSemaphore(value: 0)
    var outcome = ProofOutcome.refused
    URLSession.shared.dataTask(with: request) { data, response, error in
        defer { done.signal() }
        if let error = error as? URLError, error.code == .timedOut {
            outcome = .inconclusive
            return
        }
        guard (response as? HTTPURLResponse)?.statusCode == 200, let data = data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let proof = json["proof"] as? String else { return }
        // Compare without an early exit, so the time taken says nothing about how much matched.
        let a = Array(proof.utf8), b = Array(expected.utf8)
        var diff = UInt8(a.count == b.count ? 0 : 1)
        for i in 0..<min(a.count, b.count) { diff |= a[i] ^ b[i] }
        outcome = diff == 0 ? .proven : .refused
    }.resume()
    if done.wait(timeout: .now() + 3) == .timedOut { return .inconclusive }
    return outcome
}

func isAlive(_ pid: pid_t) -> Bool { kill(pid, 0) == 0 || errno == EPERM }

/// The pids listening on TCP `port`, from `lsof`. A process of ANOTHER account is invisible to a non-root
/// `lsof`, so "every listener is the pid I started" is a positive answer a port squatter cannot fake.
/// Blocking: off the main thread only.
func listenerPids(port: Int) -> [pid_t] {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
    // Exactly the address the window talks to (critic r3 L2), not any address on the port.
    p.arguments = ["-nP", "-iTCP@127.0.0.1:\(port)", "-sTCP:LISTEN", "-t"]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return [] }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (String(data: data, encoding: .utf8) ?? "").split(separator: "\n").compactMap { pid_t(String($0)) }
}

// MARK: - the app

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply, WKDownloadDelegate {
    let config = LaunchConfig.load()
    var window: NSWindow!
    var webView: WKWebView!
    /// The `till up` this app started or adopted, and stops on Quit.
    var serverPid: pid_t?
    var serverProcess: Process?
    var watchdog: Timer?
    var lastRekey = Date.distantPast
    /// When the app last brought a vanished server back by itself (D166 point 8): at most once a minute,
    /// so a server that keeps dying shows the stopped page instead of restarting in a loop.
    var lastAutoRestart = Date.distantPast
    /// Bumped by every automatic restart, so a `startOrAdopt` still running for the server that just
    /// went never acts on its stale outcome (it would show "not safe" over the restarted Studio).
    var launchGeneration = 0
    var quitting = false
    /// Set while the app itself loads the Studio, so `decidePolicyFor` lets exactly that navigation through.
    var appNavigation = false

    /// The kinds of website data a page could leave behind to run again later: the HTTP cache, service
    /// workers and, since the window pairs no device key, IndexedDB (critic r2 M and L2). The pairing
    /// marker in localStorage is harmless and stays.
    static let staleData: Set<String> = [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache,
                                         WKWebsiteDataTypeFetchCache, WKWebsiteDataTypeServiceWorkerRegistrations,
                                         WKWebsiteDataTypeOfflineWebApplicationCache, WKWebsiteDataTypeIndexedDBDatabases]

    /// The live lock of OUR `till up` (started or adopted) and the key, when the server on the port
    /// PROVES it holds that key; nil otherwise. A ticket is only ever derived after this. Strict: a slow
    /// answer is no proof. Blocking: off the main thread only.
    func provenLock() -> (LiveLock, String)? {
        guard let lock = readLiveLock(config), lock.pid == serverPid, let key = readStudioKey(config.supportDir),
              proveServer(config, key: key, lock: lock) == .proven else { return nil }
        return (lock, key)
    }

    /// Is the server on the port still OURS? Blocking: off the main thread only.
    ///
    /// A matching proof says yes. Anything short of it (a wrong proof, no answer in time) says yes ONLY
    /// when every process listening on the port is the `till up` this app started or adopted: then the
    /// page can only have come from it, and the miss is a busy server (a large import is synchronous)
    /// or a proof racing a rotation, not a squatter. A slow answer is never a pass on its own (security
    /// review: a squatter could simply never answer).
    func serverIsOurs() -> Bool {
        guard let pid = serverPid, isAlive(pid), let lock = readLiveLock(config), lock.pid == pid else { return false }
        if let key = readStudioKey(config.supportDir), proveServer(config, key: key, lock: lock) == .proven { return true }
        let listeners = listenerPids(port: config.port)
        return !listeners.isEmpty && listeners.allSatisfy { $0 == pid }
    }

    /// Check the server again while the Studio is showing, and replace the page the moment it is not ours.
    func recheck() {
        DispatchQueue.global(qos: .utility).async {
            let ours = self.serverIsOurs()
            DispatchQueue.main.async { if !ours && !self.quitting && self.serverPid != nil { self.showForeign() } }
        }
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()

        let frame = NSRect(x: 0, y: 0, width: 1320, height: 880)
        window = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "TILL"
        window.center()
        window.setFrameAutosaveName("TILLMainWindow")

        let configuration = WKWebViewConfiguration()
        // The Studio asks for a fresh key through this handler when the engine refuses it (D166).
        configuration.userContentController.add(self, name: "till")
        // D166 point 8: the first-run door asks for a book file through the native open panel. A
        // reply-capable handler, so the page's `postMessage` resolves with the chosen path (or null).
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "tillPick")
        configuration.websiteDataStore = .default() // keeps this window's pairing across launches
        webView = WKWebView(frame: frame, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        showMessage(L("TILL wird gestartet …", "Starting TILL …"), "")
        // Nothing a previous page left on this origin may run again (critic H1/M1): the HTTP cache, any
        // service worker and IndexedDB go at launch, and again before every load (`loadStudio`).
        WKWebsiteDataStore.default().removeData(ofTypes: AppDelegate.staleData, modifiedSince: .distantPast) {
            DispatchQueue.global(qos: .userInitiated).async { self.startOrAdopt() }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationWillTerminate(_ note: Notification) {
        quitting = true
        stopServer()
    }

    // MARK: server lifecycle

    func startOrAdopt() {
        let generation = launchGeneration
        if let lock = readLiveLock(config) {
            serverPid = lock.pid
            log("adopted till up pid \(lock.pid) on port \(config.port)")
        } else if answers() {
            // Something that is not our `till up` holds the port: say so rather than load it.
            DispatchQueue.main.async {
                self.showMessage(L("Der Port \(self.config.port) ist belegt.", "Port \(self.config.port) is in use."),
                                 L("Ein anderes Programm verwendet ihn. Beende es und öffne TILL noch einmal.",
                                   "Another program is using it. Quit that program and open TILL again."))
            }
            return
        } else {
            startServer()
        }
        for _ in 0..<120 { // up to 60 s: a first start creates the book
            if answers() { break }
            if let pid = serverPid, !isAlive(pid) { break }
            Thread.sleep(forTimeInterval: 0.5)
        }
        // Load only once the server PROVES it is the `till up` the lock names (critic H1). A port that
        // answers without that proof is someone else's and gets nothing, not even the bare URL.
        var proven = provenLock()
        for _ in 0..<20 where proven == nil && serverPid.map(isAlive) == true {
            Thread.sleep(forTimeInterval: 0.5)
            proven = provenLock()
        }
        DispatchQueue.main.async {
            guard generation == self.launchGeneration else { return } // superseded by an automatic restart
            guard let (lock, key) = proven else {
                if self.serverPid.map(isAlive) == true {
                    self.showForeign()
                } else {
                    self.serverStopped()
                }
                return
            }
            self.loadStudio(lock: lock, key: key)
            self.watch()
        }
    }

    func startServer() {
        let resources = Bundle.main.resourcePath ?? ""
        let bundled = resources + "/app/bin/till.mjs"
        let bundledNode = resources + "/runtime/bin/node"
        let p = Process()
        var env = ProcessInfo.processInfo.environment
        if config.command == nil,
           FileManager.default.isExecutableFile(atPath: bundledNode),
           FileManager.default.fileExists(atPath: bundled) {
            // The release build (build-release.sh): its own signed Node and the packed package, so a Mac
            // with no Node installed runs it. No login shell: nothing from the person's PATH or shell
            // profile decides which runtime opens the book. The bundled bin goes first on PATH so any
            // `node` the server spawns is the same pinned runtime.
            p.executableURL = URL(fileURLWithPath: bundledNode)
            p.arguments = [bundled, "up", "--no-open"]
            env["PATH"] = resources + "/runtime/bin:" + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        } else {
            let command: String
            if let configured = config.command {
                command = "exec " + shellQuote(configured)
            } else {
                command = FileManager.default.fileExists(atPath: bundled)
                    ? "exec node \(shellQuote(bundled)) up --no-open"
                    : "exec till up --no-open"
            }
            p.executableURL = URL(fileURLWithPath: "/bin/zsh")
            // A login shell, so a Finder launch sees the person's PATH (node, till); `exec` keeps the pid
            // the server's own, which is the pid Quit signals.
            p.arguments = ["-lc", command]
        }
        env["TILL_PORT"] = String(config.port)
        env["TILL_SUPPORT_DIR"] = config.supportDir
        env["TILL_NO_OPEN"] = "1"
        // D166 point 8: `till up` restarts itself after the Studio adopted a book by exiting 75; under
        // this flag it leaves the restart to the app (`serverExited`) instead of spawning a successor.
        env["TILL_SUPERVISED"] = "app"
        p.environment = env
        p.standardInput = FileHandle.nullDevice
        if let handle = logHandle() {
            p.standardOutput = handle
            p.standardError = handle
        }
        // Know at once when the server we started goes (exit 75 after an adopt, or a crash), rather than
        // at the next watchdog tick.
        p.terminationHandler = { [weak self] proc in
            let pid = proc.processIdentifier
            let status = proc.terminationStatus
            DispatchQueue.main.async { self?.serverExited(pid, status: status) }
        }
        do {
            try p.run()
            serverProcess = p
            serverPid = p.processIdentifier
            log("started till up pid \(p.processIdentifier) on port \(config.port)")
        } catch {
            log("could not start till up: \(error)")
        }
    }

    /// TERM, then KILL after 5 seconds (a busy `till up` closes its bank-sync workers and the book). A
    /// KILL is safe: SQLite's WAL keeps every committed write, and `till up` reclaims a stale lock.
    func stopServer() {
        watchdog?.invalidate()
        guard let pid = serverPid else { return }
        serverPid = nil
        kill(pid, SIGTERM)
        for _ in 0..<20 {
            if !isAlive(pid) { log("till up pid \(pid) stopped"); return }
            Thread.sleep(forTimeInterval: 0.25)
        }
        kill(pid, SIGKILL)
        log("till up pid \(pid) killed after 5 s")
    }

    /// Every 5 seconds: the server died on its own (a crash, killed in a terminal), so say so and offer a
    /// restart; or the port no longer PROVES it is ours, so the page goes (critic H1: code from another
    /// program must not stay in this window, next to the device key and the `till` handler).
    func watch() {
        watchdog?.invalidate()
        watchdog = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            guard let self = self, !self.quitting, let pid = self.serverPid else { return }
            if !isAlive(pid) {
                self.serverExited(pid, status: nil)
                return
            }
            self.recheck()
        }
    }

    /// The server this app started or adopted is gone (D166 point 8). It exits 75 after the Studio
    /// adopted a book, and an adopted terminal `till up` replaces itself with a successor; a crash looks
    /// the same from here. Bring it back by itself, at most once a minute: `startOrAdopt` adopts a live
    /// successor or starts a new server, and loads nothing until that server PROVES it holds the key,
    /// exactly as at launch. Inside the minute, the stopped page with its Restart button, as before.
    func serverExited(_ pid: pid_t, status: Int32?) {
        guard !quitting, serverPid == pid else { return } // a Quit, or a server already replaced
        serverPid = nil
        serverProcess = nil
        watchdog?.invalidate()
        // Exit 75 is a restart the person asked for (an adopted or forgotten book): it never counts
        // against the once-a-minute limit, which exists for servers that die on their own (critic L1).
        let deliberate = status == 75
        guard deliberate || Date().timeIntervalSince(lastAutoRestart) > 60 else {
            serverStopped()
            return
        }
        if !deliberate { lastAutoRestart = Date() }
        launchGeneration += 1
        log("till up pid \(pid) exited\(status.map { " (\($0))" } ?? ""); restarting")
        showMessage(L("TILL wird neu gestartet …", "Restarting TILL …"), "")

        DispatchQueue.global(qos: .userInitiated).async {
            // A respawning `till up` takes a moment to write its lock: give a successor up to 5 seconds
            // to appear before starting one, so two servers never race for the port. Exit 75 has none.
            if !deliberate {
                for _ in 0..<10 where readLiveLock(self.config) == nil { Thread.sleep(forTimeInterval: 0.5) }
            }
            self.startOrAdopt()
        }
    }

    func showForeign() {
        watchdog?.invalidate()
        showMessage(L("TILL kann sich nicht sicher verbinden.", "TILL cannot connect safely."),
                    L("Auf Port \(config.port) antwortet ein Programm, das nicht dein TILL ist. Beende TILL, warte einen Moment und öffne es noch einmal.",
                      "A program that is not your TILL answers on port \(config.port). Quit TILL, wait a moment and open it again."),
                    action: L("Neu verbinden", "Reconnect"))
    }

    func serverStopped() {
        watchdog?.invalidate()
        showMessage(L("TILL läuft nicht mehr.", "TILL is not running."),
                    L("Details stehen im Protokoll \(config.logFile).", "Details are in the log \(config.logFile)."),
                    action: L("Neu starten", "Restart"))
    }

    func answers() -> Bool {
        guard let url = URL(string: config.baseURL + "/") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        let done = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode < 500 { ok = true }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 2)
        return ok
    }

    // MARK: the Studio

    /// Load the Studio with a one-time ticket derived from the key for the `till up` that just PROVED it
    /// holds that key. The request bypasses the cache: the page must come from that server, now.
    func loadStudio(lock: LiveLock, key: String) {
        // Whatever a page left behind since the last load (a service worker above all) goes first, so
        // the ticket is handed to a navigation no leftover code controls (critic r2 M).
        WKWebsiteDataStore.default().removeData(ofTypes: AppDelegate.staleData, modifiedSince: .distantPast) {
            guard let ticket = deriveTicket(key: key, lock: lock),
                  let url = URL(string: "\(self.config.baseURL)/#t=\(ticket)") else { return }
            self.appNavigation = true
            self.webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
        }
    }

    /// Prove the server again, then load (the menu's Reload, a rekey, a retry after a slow start).
    func proveAndLoad() {
        DispatchQueue.global(qos: .userInitiated).async {
            let proven = self.provenLock()
            DispatchQueue.main.async {
                if let (lock, key) = proven { self.loadStudio(lock: lock, key: key) } else { self.showForeign() }
            }
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "till", let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        // Only the Studio this app loaded may ask: the frame must be the main frame on our own origin.
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host == "127.0.0.1",
              message.frameInfo.securityOrigin.port == config.port else { return }
        switch type {
        case "rekey":
            // At most one rekey per 10 seconds: a key the engine refuses must not reload in a loop.
            guard Date().timeIntervalSince(lastRekey) > 10 else { return }
            lastRekey = Date()
            proveAndLoad()
        default:
            return
        }
    }

    /// `tillPick` (D166 point 8): the first-run door's "Datei wählen …". It opens the native open panel
    /// as a sheet (one file, no folders) and replies with the chosen file's path, or nil when cancelled.
    /// Nothing else: it reads no file and changes nothing; the Studio sends the path to the server, which
    /// probes it. Accepted only from the Studio this app loaded (the main frame, our own origin), like
    /// the `till` handler.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.name == "tillPick", message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host == "127.0.0.1",
              message.frameInfo.securityOrigin.port == config.port,
              window.attachedSheet == nil else {
            replyHandler(nil, nil)
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.resolvesAliases = true
        panel.title = L("Hauptbuch wählen", "Choose your book")
        panel.message = L("Wähle die Datei deines TILL-Hauptbuchs.", "Choose the file of your TILL book.")
        panel.prompt = L("Wählen", "Choose")
        panel.beginSheetModal(for: window) { result in
            replyHandler(result == .OK ? panel.url?.path : nil, nil)
        }
    }

    // MARK: messages shown by the app itself

    func showMessage(_ title: String, _ body: String, action: String? = nil) {
        let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
        let button = action.map { "<p><a href=\"till-app://restart\">\(esc($0))</a></p>" } ?? ""
        let html = """
        <!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
        <style>
          html,body{height:100%;margin:0}
          body{display:flex;align-items:center;justify-content:center;font:15px/1.5 -apple-system,system-ui,sans-serif;
               background:#faf8f4;color:#1f1d1a}
          @media (prefers-color-scheme: dark){body{background:#161513;color:#ece8e1}}
          main{max-width:32rem;padding:24px}
          h1{font-size:22px;font-weight:600;margin:0 0 8px}
          p{margin:0 0 12px;opacity:.75}
          a{color:inherit}
        </style></head><body><main><h1>\(esc(title))</h1><p>\(esc(body))</p>\(button)</main></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // MARK: navigation: the Studio stays in the window, everything else goes to the browser

    func isStudio(_ url: URL) -> Bool {
        (url.host == "127.0.0.1" || url.host == "localhost") && url.port == config.port
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { decisionHandler(.allow); return }
        if scheme == "till-app" {
            decisionHandler(.cancel)
            if url.host == "restart" {
                showMessage(L("TILL wird gestartet …", "Starting TILL …"), "")
                DispatchQueue.global(qos: .userInitiated).async { self.startOrAdopt() }
            }
            return
        }
        if action.shouldPerformDownload { decisionHandler(.download); return }
        switch scheme {
        case "http", "https":
            if isStudio(url) {
                let mainFrame = action.targetFrame?.isMainFrame ?? true
                if !mainFrame {
                    decisionHandler(.allow) // a subframe never uses up the app's own load (critic r3 L1)
                    return
                }
                if appNavigation {
                    appNavigation = false
                    decisionHandler(.allow)
                    return
                }
                // A page-initiated load of the Studio (a reload, a link to another Studio path): only
                // onto a server that is still ours (critic r2 M; `serverIsOurs` never passes on silence).
                DispatchQueue.global(qos: .userInitiated).async {
                    let ours = self.serverIsOurs()
                    DispatchQueue.main.async {
                        if ours {
                            decisionHandler(.allow)
                        } else {
                            decisionHandler(.cancel)
                            self.showForeign()
                        }
                    }
                }
            } else {
                NSWorkspace.shared.open(url) // the web goes to the person's browser
                decisionHandler(.cancel)
            }
        case "mailto":
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        case "about", "blob", "data":
            decisionHandler(.allow) // the app's own messages and the Studio's in-page files
        default:
            // file:, custom app schemes and the rest: never handed to the operating system from a page.
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        decisionHandler(!response.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") ? .download : .allow)
    }

    /// After every Studio page load, prove the server again: closes the gap between the proof and the
    /// load (a port that changed hands in between), so foreign code is replaced within moments.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        appNavigation = false // whatever happened to the app's own load, the flag never outlives it
        guard let url = webView.url, isStudio(url), !quitting else { return }
        recheck()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        appNavigation = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        appNavigation = false
        if quitting { return }
        // Still binding on a slow first start: try once more shortly.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.proveAndLoad() }
    }

    /// `target="_blank"` and `window.open`: the window for the Studio, the system browser for http(s)
    /// and mail, and NOTHING for any other scheme (a page must not hand `file:` or an app's custom URL
    /// scheme to the operating system).
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { return nil }
        if isStudio(url) {
            webView.load(action.request)
        } else if scheme == "http" || scheme == "https" || scheme == "mailto" {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    // MARK: downloads (pain.001 files, PDFs) land in ~/Downloads

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory() + "/Downloads")
        let name = (suggestedFilename as NSString).lastPathComponent
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var target = folder.appendingPathComponent(name)
        var n = 1
        while FileManager.default.fileExists(atPath: target.path) {
            n += 1
            target = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
        }
        completionHandler(target)
    }

    func downloadDidFinish(_ download: WKDownload) {
        NSSound(named: "Glass")?.play()
    }

    // MARK: file pickers and JavaScript dialogs (the Studio uses confirm and file inputs)

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: L("Abbrechen", "Cancel"))
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: L("Abbrechen", "Cancel"))
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    // MARK: plumbing

    func logHandle() -> FileHandle? {
        let fm = FileManager.default
        try? fm.createDirectory(atPath: (config.logFile as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        if !fm.fileExists(atPath: config.logFile) { fm.createFile(atPath: config.logFile, contents: nil, attributes: [.posixPermissions: 0o600]) }
        guard let handle = FileHandle(forWritingAtPath: config.logFile) else { return nil }
        handle.seekToEndOfFile()
        return handle
    }

    func log(_ line: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        guard let handle = logHandle(), let data = "TILL.app \(stamp): \(line)\n".data(using: .utf8) else { return }
        handle.write(data)
        try? handle.close()
    }

    func shellQuote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    @objc func reload() { proveAndLoad() }

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: L("Über TILL", "About TILL"), action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: L("TILL ausblenden", "Hide TILL"), action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: L("TILL beenden", "Quit TILL"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: L("Bearbeiten", "Edit"))
        edit.addItem(withTitle: L("Widerrufen", "Undo"), action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: L("Wiederholen", "Redo"), action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: L("Ausschneiden", "Cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: L("Kopieren", "Copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: L("Einsetzen", "Paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: L("Alles auswählen", "Select All"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let view = NSMenu(title: L("Darstellung", "View"))
        view.addItem(withTitle: L("Neu laden", "Reload"), action: #selector(reload), keyEquivalent: "r")
        viewItem.submenu = view

        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let windowMenu = NSMenu(title: L("Fenster", "Window"))
        windowMenu.addItem(withTitle: L("Im Dock ablegen", "Minimize"), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: L("Schliessen", "Close"), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate

// A plain `kill` (a logout script, launchd, a terminal) takes the same way out as Cmd+Q, so the server
// is stopped too instead of being orphaned on its port.
signal(SIGTERM, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termination.setEventHandler { NSApp.terminate(nil) }
termination.resume()

app.run()
