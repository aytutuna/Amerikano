import AVFoundation
import Capacitor

// Voice runs in the web view, which leaves the sound on the earpiece; this puts it on the loudspeaker while the microphone is live.
@objc(AudioRoute)
public class AudioRoute: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioRoute"
    public let jsName = "AudioRoute"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private var before: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?

    @objc func start(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        if before == nil { before = (session.category, session.mode, session.categoryOptions) }
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        guard let was = before else { return call.resolve() }
        before = nil
        do {
            try AVAudioSession.sharedInstance().setCategory(was.0, mode: was.1, options: was.2)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }
}

class ViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AudioRoute())
    }
}
