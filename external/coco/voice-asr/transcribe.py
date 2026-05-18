#!/usr/bin/env python3
"""
Transcribe audio file using local Whisper.

Installed at /opt/coco/voice-asr/transcribe.py on Pro/Ultra VMs.
Invoked via ~/zylos/bin/transcribe (shell wrapper created by bootstrap).

Usage: python3 transcribe.py <audio_file_path>
Output: transcribed text to stdout
Exit code: 0 on success, 1 on failure

Language is auto-detected — do not hard-code to a single language,
as users may speak any language.

Model is controlled by VOICE_ASR_MODEL env var (default: small).
"""
import sys
import os
import warnings

# Suppress FP16 CPU warning
warnings.filterwarnings('ignore', category=UserWarning)

MODEL = os.environ.get('VOICE_ASR_MODEL', 'small')

def main():
    if len(sys.argv) < 2:
        print('Usage: transcribe.py <audio_file>', file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        print(f'File not found: {audio_path}', file=sys.stderr)
        sys.exit(1)

    try:
        import whisper
        model = whisper.load_model(MODEL)
        result = model.transcribe(audio_path, fp16=False)
        text = result['text'].strip()
        if not text:
            print('[empty transcription]', file=sys.stderr)
            sys.exit(1)
        print(text)
    except Exception as e:
        print(f'Transcription error: {e}', file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
