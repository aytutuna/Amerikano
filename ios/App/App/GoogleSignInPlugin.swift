import AuthenticationServices
import Capacitor
import CryptoKit

@objc(GoogleSignInPlugin)
public class GoogleSignInPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "GoogleSignInPlugin"
    public let jsName = "GoogleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise)]

    private var session: ASWebAuthenticationSession?

    private func random() -> String {
        base64url(Data((0..<32).map { _ in UInt8.random(in: 0...255) }))
    }

    private func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    @objc func signIn(_ call: CAPPluginCall) {
        guard let client = call.getString("clientId"), let redirect = call.getString("redirect"), let nonce = call.getString("nonce"),
              let scheme = URL(string: redirect)?.scheme else {
            call.reject("clientId, redirect and nonce are required")
            return
        }
        let verifier = random()
        let state = random()
        var auth = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        auth.queryItems = [
            URLQueryItem(name: "client_id", value: client),
            URLQueryItem(name: "redirect_uri", value: redirect),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: "openid"),
            URLQueryItem(name: "code_challenge", value: base64url(Data(SHA256.hash(data: Data(verifier.utf8))))),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "nonce", value: nonce),
            URLQueryItem(name: "state", value: state)
        ]
        DispatchQueue.main.async {
            let s = ASWebAuthenticationSession(url: auth.url!, callbackURLScheme: scheme) { url, error in
                self.session = nil
                if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    call.reject("cancelled", "cancelled")
                    return
                }
                let items = url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems } ?? []
                guard let code = items.first(where: { $0.name == "code" })?.value,
                      items.first(where: { $0.name == "state" })?.value == state else {
                    call.reject(error?.localizedDescription ?? "no code")
                    return
                }
                self.exchange(call, code: code, client: client, redirect: redirect, verifier: verifier)
            }
            s.presentationContextProvider = self
            self.session = s
            if !s.start() {
                self.session = nil
                call.reject("could not start")
            }
        }
    }

    private func exchange(_ call: CAPPluginCall, code: String, client: String, redirect: String, verifier: String) {
        var form = URLComponents()
        form.queryItems = [
            URLQueryItem(name: "code", value: code),
            URLQueryItem(name: "client_id", value: client),
            URLQueryItem(name: "code_verifier", value: verifier),
            URLQueryItem(name: "redirect_uri", value: redirect),
            URLQueryItem(name: "grant_type", value: "authorization_code")
        ]
        var request = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = form.percentEncodedQuery?.data(using: .utf8)
        URLSession.shared.dataTask(with: request) { data, _, error in
            guard let data = data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = json["id_token"] as? String else {
                call.reject(error?.localizedDescription ?? "token exchange failed")
                return
            }
            call.resolve(["idToken": token])
        }.resume()
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
