declare module "react-native-webview" {
  import { Component } from "react";
  import { ViewStyle } from "react-native";

  export interface WebViewMessageEvent {
    nativeEvent: {
      data: string;
      url: string;
      loading?: boolean;
      title?: string;
      canGoBack?: boolean;
      canGoForward?: boolean;
      [key: string]: any;
    };
  }

  export interface WebViewSource {
    uri?: string;
    html?: string;
    headers?: Record<string, string>;
    method?: string;
    body?: string;
  }

  export interface WebViewProps {
    source: WebViewSource | { uri: string };
    style?: ViewStyle;
    originWhitelist?: string[];
    onMessage?: (event: WebViewMessageEvent) => void;
    onLoad?: (event: any) => void;
    onError?: (event: any) => void;
    onLoadStart?: (event: any) => void;
    onLoadEnd?: (event: any) => void;
    javaScriptEnabled?: boolean;
    domStorageEnabled?: boolean;
    geolocationEnabled?: boolean;
    startInLoadingState?: boolean;
    renderLoading?: () => React.ReactElement;
    renderError?: () => React.ReactElement;
    injectedJavaScript?: string;
    ref?: React.Ref<WebView>;
    [key: string]: any;
  }

  export class WebView extends Component<WebViewProps> {
    postMessage: (message: string) => void;
    injectJavaScript: (script: string) => void;
    reload: () => void;
    goBack: () => void;
    goForward: () => void;
  }

  export default WebView;
}
