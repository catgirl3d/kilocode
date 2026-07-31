---
title: Voice Transcription
description: Dictate prompts through your signed-in Kilo account.
---

# Voice Transcription

Use voice input in prompt fields instead of typing. When the Kilo provider is enabled and you are signed in, the microphone appears automatically and transcription uses your account through Kilo Gateway.

---

## Get ready

Voice input needs FFmpeg plus access to the Kilo provider.

### Install FFmpeg

FFmpeg is required for audio capture and processing. Install it for your platform:

**macOS:**

```bash
brew install ffmpeg
```

**Linux (Ubuntu/Debian):**

```bash
sudo apt update
sudo apt install ffmpeg
```

**Windows:**
Download from [ffmpeg.org/download.html](https://ffmpeg.org/download.html) and add to your system PATH.

### Sign in

Enable and sign in to the Kilo provider to use Kilo Gateway transcription models in prompt fields. These requests use your Kilo account, so no separate OpenAI provider profile or API key is needed. You can instead configure the Groq provider with an API key and select a Groq Whisper model.

---

## Choose a model

You can optionally choose a transcription model in **Settings** > **Models** > **Speech to Text Model**. Kilo Gateway models route through your Kilo account; Groq Whisper models send audio directly to Groq with the configured Groq API key. Kilo stores this choice as `experimental.speech_to_text_model` in your global Kilo CLI config (`~/.config/kilo/kilo.jsonc`).

The model list is discovered from the Kilo Gateway and reflects the transcription models available to your account or organization, so newly available models appear automatically.

---

## Record prompts

When the selected transcription provider is enabled and authenticated, a microphone button appears in prompt fields:

1. Click the microphone button to start recording
2. Speak your message clearly
3. Click again to stop recording
4. Your speech is transcribed into text

You can also use **Cmd/Ctrl+K** while a Kilo prompt or review comment field is focused. Tap it to start or stop recording, or hold it while speaking and release to transcribe and submit the focused field. Press it during transcription to cancel.

The feature includes real-time audio level visualization and voice activity detection to automatically detect when you're speaking.

---

## Review details

- **Audio processing**: Uses FFmpeg for system audio capture
- **Transcription**: Sends audio through Kilo Gateway with the selected transcription model

---

## Fix issues

**Microphone button not appearing:**

- Enable and sign in to the Kilo provider

**Transcription errors:**

- Confirm the Kilo provider remains enabled and signed in
- Verify FFmpeg is installed and in your PATH
- Check your internet connection
- Try speaking more clearly or adjusting your microphone settings

---

## Know limits

Voice transcription has these requirements:

- Requires an active internet connection
- Requires Kilo Gateway access through your Kilo account
- Transcription accuracy depends on audio quality and speech clarity
