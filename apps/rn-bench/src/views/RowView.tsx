/**
 * The views every variant renders, so the state layers differ and the pixels
 * do not. A field is a node: a string for a variant that reads the row
 * whole, a cell component for one that reads each field on its own.
 */
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { mark } from "../harness/probe.ts";

export const rowHeight = 64;

export interface RowFields {
  readonly ticker: ReactNode;
  readonly name: ReactNode;
  readonly price: ReactNode;
  readonly change: ReactNode;
  readonly volume: ReactNode;
  readonly updated: ReactNode;
  readonly status: ReactNode;
}

export function RowView({
  fields,
  onPress,
}: {
  readonly fields: RowFields;
  readonly onPress: () => void;
}) {
  mark();
  return (
    <Pressable onPress={onPress} style={styles.row}>
      <View style={styles.left}>
        <Text style={styles.ticker}>{fields.ticker}</Text>
        <Text style={styles.muted} numberOfLines={1}>
          {fields.name} · {fields.status}
        </Text>
      </View>
      <View style={styles.right}>
        <Text style={styles.price}>{fields.price}</Text>
        <Text style={styles.muted}>
          {fields.change} · {fields.volume} · {fields.updated}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    height: rowHeight,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
  },
  left: { flex: 1 },
  right: { alignItems: "flex-end" },
  ticker: { fontSize: 16, fontWeight: "600" },
  price: { fontSize: 16, fontVariant: ["tabular-nums"] },
  muted: { fontSize: 12, color: "#777" },
});
