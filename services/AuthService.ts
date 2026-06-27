import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchWithTimeout } from './fetchWithTimeout';

const API_BASE_URL = 'https://api.cbinformatica.net:9031';

const SESSION_STORAGE_KEY = '@awesomeapp/current_user';

export type Usuario = {
  claveEmpleado: string;
  password?: string;
  sucursal?: number | null;
  sucursal_origen?: number | null;
  idDepartamento?: number | null;
  [key: string]: any;
};

class AuthService {
  private _currentUser: Usuario | null = null;

  get currentUser() {
    return this._currentUser;
  }

  async login(usuario: string, password: string): Promise<Usuario> {
    console.log('Logging in user:', usuario);
    const url = `${API_BASE_URL}/api/Login/${encodeURIComponent(
      usuario,
    )}/${encodeURIComponent(password)}`;

    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        throw new Error(`Error de conexión (${res.status}: ${res.statusText})`);
      }
      const data = await res.json();

      // Verificar si la respuesta contiene un error del servidor
      if (data && typeof data === 'object' && 'error' in data) {
        throw new Error(data.error || 'Error en el servidor');
      }

      if (!Array.isArray(data) || data.length === 0) {
        throw new Error('Usuario o contraseña incorrectos');
      }

      const user: Usuario = data[0];

      if (!user.sucursal_origen && user.sucursal) {
        user.sucursal_origen = user.sucursal;
      }

      this._currentUser = user;

      try {
        await AsyncStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(user));
      } catch (storageError) {
        console.error(
          'No fue posible guardar la sesión localmente:',
          storageError,
        );
      }

      return user;
    } catch (error) {
      console.error('[AuthService] Error en login:', error);
      throw error;
    }
  }

  async restoreSession(): Promise<Usuario | null> {
    if (this._currentUser) {
      return this._currentUser;
    }

    console.log('Attempting to restore session from storage');
    try {
      const stored = await AsyncStorage.getItem(SESSION_STORAGE_KEY);
      if (!stored) {
        return null;
      }

      const parsed: Usuario = JSON.parse(stored);
      console.log('Session restored:', parsed);
      this._currentUser = parsed;
      return parsed;
    } catch (error) {
      console.error('No fue posible restaurar la sesión:', error);
      return null;
    }
  }

  async logout() {
    this._currentUser = null;

    try {
      await AsyncStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (error) {
      console.error('No fue posible limpiar la sesión local:', error);
    }
  }
}

export default new AuthService();
