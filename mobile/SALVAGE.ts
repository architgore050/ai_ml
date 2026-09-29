// SALVAGE — copy from here, do not import from the old tree.
// Source: mobile/src @ 782ffec (git show 782ffec:mobile/src/...)
// Read-only reference. Delete this file once 1.x is complete.
//
// KEEP -------------------------------------------------------------------

// 1. Single-flight refresh mutex. from api.ts:75-114
//    The one genuinely correct thing in the old client. REWRITTEN in the new
//    client; kept here so the shape is not lost. Note the two changes:
//      - requires data.refresh (ROTATE_REFRESH_TOKENS is on, settings.py:776)
//      - drops the `data.refresh || tokens.refresh` fallback
let refreshPromise: Promise<string | null> | null = null;

// 2. Audio mode. from audioPlayer.ts:19-25
//    Retarget to expo-audio's setAudioModeAsync.
//    Allows recording is now explicit: false for playback, true for capture.
const AUDIO_MODE_PLAYBACK = {
  playsInSilentModeIOS: true,
  staysActiveInBackground: true,
  shouldDuckAndroid: true,
};

// 3. Recording preset. from UploadScreen.tsx:58-60
//    .m4a / AAC / 44.1kHz / stereo / 128kbps.
//    '.m4a' IS in ALLOWED_EXT (serializers.py:129).
//    Add isMeteringEnabled — it appears NOWHERE in the old app, so the level
//    meter is net-new (plan §12 was wrong about this).
const RECORDING_PRESET = 'HIGH_QUALITY'; // expo-audio: AudioRecordingPresets.HIGH_QUALITY

// 4. CommentSheet composition. from CommentModal.tsx:75-79
//    Keep the composition (KeyboardAvoidingView + drag indicator).
//    Reimplement on @gorhom/bottom-sheet.
const SHEET_LAYOUT = {
  // behavior: Platform.OS === 'ios' ? 'padding' : undefined
  // indicator: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center' }
  // height: '65%'
};

// 5. app identity. from app.json:16,18-20,25,37
const IDENTITY = {
  ios: { bundleIdentifier: 'com.echoflow.audio' },
  android: { package: 'com.echoflow.audio' },
  scheme: 'echoflow',
  UIBackgroundModes: ['audio'], // expo-audio's plugin emits this; declare intent anyway
  NSMicrophoneUsageDescription:
    'EchoFlow needs microphone access so you can record and publish audio clips.',
};
// NOTE: 'echoflow' was declared in the old app and had ZERO handlers.
// D3 (expo-router) makes it real for the first time.

// DISCARD ---------------------------------------------------------------
// App.tsx navigation ....... bottom tabs, `navigation: any`, no linking,
//                             no param typing, no error boundary, no auth gate
// AuthContext.tsx .......... isAuthenticated: !!user (derived, not
//                             authoritative); login() unreachable — there is no
//                             register or login fn in api.ts, authAPI has only
//                             logout; loadAuth calls refreshProfile() in a try
//                             with no catch, unawaited → unhandled rejection
// UploadScreen.tsx:34 ...... consentAccepted = useState(true)  ← DPDP §11
// FeedScreen.tsx:93-104 ... useRef(...).current freezes currentIndex + clips
//                             from the first render, so clips[index] is
//                             undefined forever → scrolling never changes track
// PlayerContext:136-140 .... didJustFinish → skipNext() → registerSkip(0,0,0)
//                             → natural completion counted as a skip
// audioPlayer.ts:53-59 ..... createAsync({uri}, …) passes NO headers → no media
//                             auth at all; 403s against the token-gated edge
// audioPlayer.ts:112-128 .. flushTelemetry measures Date.now() - startTimeMs
// AudioVisualizer.tsx:26 .. Math.random() re-rolled per cycle
// api.ts:245 ............... toggleFollow sends GET to a POST-only route
// api.ts:15-21 ............. base URL is http://localhost:8005 / 10.0.2.2:8005
// ShareModal.tsx:47 ........ shares hls_playlist_url — token-gated, 403s for
//                             the recipient
// styling layer ............ 125 hex, 8 StyleSheet.create, no tokens, and the
//                             palette is frontend/src's orange #FF6321, not the
//                             design source's terracotta #e8a87c
// app.json:40-45 ........... expo-av plugin, expo-asset plugin
