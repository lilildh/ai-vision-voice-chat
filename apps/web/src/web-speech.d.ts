type BrowserSpeechRecognitionErrorEvent = {
  error: string;
};

type BrowserSpeechRecognitionResult = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternative | undefined;
};

type BrowserSpeechRecognitionResultEvent = {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: BrowserSpeechRecognitionResult;
  };
};

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onend: ((event: Event) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onresult: ((event: BrowserSpeechRecognitionResultEvent) => void) | null;
  onstart: ((event: Event) => void) | null;
  abort(): void;
  start(): void;
  stop(): void;
}

interface BrowserSpeechRecognitionConstructor {
  new (): BrowserSpeechRecognition;
}

interface Window {
  SpeechRecognition?: BrowserSpeechRecognitionConstructor;
  webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
}
