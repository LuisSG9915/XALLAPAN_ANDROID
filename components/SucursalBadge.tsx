import React from "react";
import { View, Text, StyleSheet } from "react-native";
import AuthService from "../services/AuthService";
import { COLORS, BORDER_RADIUS } from "../theme/theme";

export default function SucursalBadge() {
  const user = AuthService.currentUser;
  if (!user) return null;

  const sucursalNumber = user.sucursal_origen || user.sucursal || 0;
  const sucursalName = user.dSucursal || user.sucursalNombre || null;

  return (
    <View style={styles.badge}>
      {sucursalName ? (
        <Text style={styles.text}>
          {sucursalNumber} 
        </Text>
      ) : (
        <Text style={styles.text}></Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    backgroundColor: "rgba(255,255,255,0.2)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: BORDER_RADIUS.s,
  },
  text: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
  },
});
