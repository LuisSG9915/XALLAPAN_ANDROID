import { createNavigationContainerRef } from "@react-navigation/native";

export const navigationRef = createNavigationContainerRef<any>();

export function navigate(name: string, params?: any): void {
  if (navigationRef.isReady()) {
    navigationRef.navigate(name, params);
  } else {
    console.warn("[navigationRef] Navegador no listo, no se pudo navegar a:", name);
  }
}
