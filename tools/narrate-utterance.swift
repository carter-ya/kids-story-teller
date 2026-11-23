// Run with Apple's system Swift interpreter so AVFoundation can access the installed voices.
import AVFoundation
import Foundation

let args = CommandLine.arguments
guard args.count == 6,
      let rate = Float(args[3]),
      let pitch = Float(args[4]) else {
    fputs("Usage: swift narrate-utterance.swift VOICE TEXT RATE PITCH OUTPUT.caf\n", stderr)
    exit(1)
}
guard let voice = AVSpeechSynthesisVoice.speechVoices().first(where: { $0.identifier == args[1] }) else {
    fputs("This Mac does not have the requested Mandarin voice: \(args[1])\n", stderr)
    exit(2)
}

let utterance = AVSpeechUtterance(string: args[2])
utterance.voice = voice
utterance.rate = rate
utterance.pitchMultiplier = pitch
let destination = URL(fileURLWithPath: args[5])
let synthesizer = AVSpeechSynthesizer()
var output: AVAudioFile?
var hasFailed = false
var isComplete = false
var frameCount = 0

synthesizer.write(utterance) { buffer in
    guard let pcm = buffer as? AVAudioPCMBuffer else { return }
    guard pcm.frameLength > 0 else {
        output = nil
        isComplete = true
        return
    }
    do {
        if output == nil {
            output = try AVAudioFile(forWriting: destination, settings: pcm.format.settings)
        }
        try output?.write(from: pcm)
        frameCount += Int(pcm.frameLength)
    } catch {
        fputs("Failed writing speech: \(error)\n", stderr)
        hasFailed = true
        isComplete = true
    }
}

let deadline = Date().addingTimeInterval(30)
while !isComplete && Date() < deadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.02))
}
guard isComplete, !hasFailed, frameCount > 1000 else {
    fputs("Voice render timed out or produced insufficient audio.\n", stderr)
    exit(3)
}
