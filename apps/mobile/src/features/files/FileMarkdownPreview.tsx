import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";

import { MarkdownBlock } from "../../components/MarkdownBlock";

export function FileMarkdownPreview(props: {
  readonly markdown: string;
  readonly onRefresh?: () => Promise<void> | void;
}) {
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const handlePullToRefresh = useCallback(async () => {
    if (!props.onRefresh) {
      return;
    }
    setIsPullRefreshing(true);
    try {
      await props.onRefresh();
    } finally {
      setIsPullRefreshing(false);
    }
  }, [props.onRefresh]);

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      contentContainerStyle={{ padding: 18 }}
      refreshControl={
        props.onRefresh ? (
          <RefreshControl
            refreshing={isPullRefreshing}
            onRefresh={() => void handlePullToRefresh()}
          />
        ) : undefined
      }
    >
      <View className="mx-auto w-full max-w-[760px]">
        <MarkdownBlock markdown={props.markdown} />
      </View>
    </ScrollView>
  );
}
