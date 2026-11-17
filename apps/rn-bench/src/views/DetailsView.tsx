/**
 * The details screen. It covers the list, which stays mounted under it, as a
 * stack navigator keeps the screen below.
 */
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { PointText } from "../data/format.ts";
import { mark } from "../harness/probe.ts";

export interface DetailsFields {
  readonly ticker: ReactNode;
  readonly name: ReactNode;
  readonly status: ReactNode;
  readonly price: ReactNode;
  readonly change: ReactNode;
  readonly volume: ReactNode;
  readonly updated: ReactNode;
  readonly listed: ReactNode;
  readonly tags: ReactNode;
  readonly network: ReactNode;
  readonly contract: ReactNode;
  readonly decimals: ReactNode;
  readonly limits: ReactNode;
}

export function DetailsView({
  fields,
  history,
  onClose,
}: {
  readonly fields: DetailsFields;
  readonly history: ReactNode;
  readonly onClose: () => void;
}) {
  mark();
  return (
    <View style={styles.screen}>
      <Pressable onPress={onClose} style={styles.close}>
        <Text>Close</Text>
      </Pressable>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{fields.ticker}</Text>
        <Text style={styles.muted}>{fields.name}</Text>
        <Line label="Status">{fields.status}</Line>
        <Line label="Price">{fields.price}</Line>
        <Line label="24h">{fields.change}</Line>
        <Line label="Volume">{fields.volume}</Line>
        <Line label="Updated">{fields.updated}</Line>
        <Line label="Listed">{fields.listed}</Line>
        <Line label="Tags">{fields.tags}</Line>
        <Line label="Network">{fields.network}</Line>
        <Line label="Contract">{fields.contract}</Line>
        <Line label="Decimals">{fields.decimals}</Line>
        <Line label="Limits">{fields.limits}</Line>
        <Text style={styles.section}>History</Text>
        {history}
      </ScrollView>
    </View>
  );
}

function Line({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View style={styles.line}>
      <Text style={styles.muted}>{label}</Text>
      <Text>{children}</Text>
    </View>
  );
}

export function HistoryView({ points }: { readonly points: ReadonlyArray<PointText> }) {
  mark();
  return (
    <View>
      {points.map((point) => (
        <View key={point.at} style={styles.line}>
          <Text style={styles.muted}>{point.at}</Text>
          <Text>{point.price}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { ...StyleSheet.absoluteFillObject, backgroundColor: "#fff" },
  close: { padding: 16, paddingTop: 60 },
  content: { padding: 16 },
  title: { fontSize: 24, fontWeight: "700" },
  section: { marginTop: 16, fontWeight: "600" },
  line: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  muted: { color: "#777" },
});
