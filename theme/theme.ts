export const APP_NAME = 'Xallapan';

export const COLORS = {
  primary: '#2B306E',
  primaryDark: '#1A1F4A',
  primaryLight: '#E4E5E7',
  secondary: '#64AD45',
  background: '#FFFFFF',
  surface: '#E4E5E7',
  border: '#D0D0D0',
  textPrimary: '#1A1A1A',
  textSecondary: '#666666',
  muted: '#999999',
  success: '#64AD45',
  warning: '#FF9800',
  error: '#D32F2F',
  info: '#2B306E',
  // Card gradients or specific colors
  cards: {
    sales: '#2B306E',
    billing: '#64AD45',
    precorte: '#607D8B',
    traspaso: '#3F51B5',
    report: '#009688',
    data: '#00897B',
    settings: '#5E35B1',
  },
};

export const SPACING = {
  xs: 4,
  s: 8,
  m: 16,
  l: 24,
  xl: 32,
  xxl: 40,
};

export const SHADOWS = {
  small: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  medium: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 4,
  },
  large: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 8,
  },
};

export const BORDER_RADIUS = {
  s: 8,
  m: 12,
  l: 16,
  xl: 24,
  xxl: 32,
  round: 9999,
};

export const TYPOGRAPHY = {
  h1: { fontSize: 32, fontWeight: 'bold' as 'bold', color: COLORS.textPrimary },
  h2: { fontSize: 24, fontWeight: 'bold' as 'bold', color: COLORS.textPrimary },
  h3: { fontSize: 20, fontWeight: '600' as '600', color: COLORS.textPrimary },
  body: { fontSize: 16, color: COLORS.textPrimary },
  caption: { fontSize: 14, color: COLORS.textSecondary },
  small: { fontSize: 12, color: COLORS.muted },
};
