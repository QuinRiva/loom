import { Pressable, StyleSheet, View } from "react-native";

import { T3HeaderButton } from "../../native/T3HeaderButton.ios";

type SidebarFilterButtonIcon =
  | "line.3.horizontal.decrease.circle"
  | "line.3.horizontal.decrease.circle.fill";

export function SidebarFilterButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: SidebarFilterButtonIcon;
}) {
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      style={styles.button}
    >
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <T3HeaderButton
          accessibilityLabel={props.accessibilityLabel}
          icon={props.icon}
          onPress={() => undefined}
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 44,
    height: 44,
  },
});
