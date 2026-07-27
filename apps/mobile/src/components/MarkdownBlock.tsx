import { useCallback, useMemo } from "react";
import {
  Markdown,
  type CustomRenderers,
  type NodeStyleOverrides,
  type PartialMarkdownTheme,
} from "react-native-nitro-markdown";
import { Text as NativeText } from "react-native";

import { tryOpenExternalUrl } from "../lib/openExternalUrl";
import { useFontFamily } from "../lib/useFontFamily";
import {
  resolveMarkdownFontSizes,
  resolveNativeMarkdownTypography,
} from "../lib/appearancePreferences";
import { useThemeColor } from "../lib/useThemeColor";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
  type NativeMarkdownTextStyle,
} from "../native/SelectableMarkdownText";

interface MarkdownBlockStyles {
  readonly theme: PartialMarkdownTheme;
  readonly styles: NodeStyleOverrides;
  readonly renderers: CustomRenderers;
  readonly nativeTextStyle: NativeMarkdownTextStyle;
}

function useMarkdownBlockStyles(): MarkdownBlockStyles {
  const { appearance } = useAppearancePreferences();
  const markdownFontSizes = useMemo(
    () => resolveMarkdownFontSizes(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const nativeMarkdownTypography = useMemo(
    () => resolveNativeMarkdownTypography(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const body = String(useThemeColor("--color-md-body"));
  const strong = String(useThemeColor("--color-md-strong"));
  const link = String(useThemeColor("--color-md-link"));
  const blockquoteBorder = String(useThemeColor("--color-md-blockquote-border"));
  const blockquoteBackground = String(useThemeColor("--color-md-blockquote-bg"));
  const codeBackground = String(useThemeColor("--color-md-code-bg"));
  const codeText = String(useThemeColor("--color-md-code-text"));
  const horizontalRule = String(useThemeColor("--color-md-hr"));
  const regularFontFamily = useFontFamily("regular");
  const mediumFontFamily = useFontFamily("medium");
  const boldFontFamily = useFontFamily("bold");

  return useMemo(() => {
    const renderers: CustomRenderers = {
      link: ({ href, children }) => (
        <NativeText
          className="font-t3-medium"
          onPress={() => {
            if (href) {
              void tryOpenExternalUrl(href, "markdown-link");
            }
          }}
          style={{
            color: link,
            textDecorationLine: "none",
          }}
        >
          {children}
        </NativeText>
      ),
    };

    return {
      theme: {
        colors: {
          text: body,
          heading: strong,
          link,
          blockquote: blockquoteBorder,
          border: horizontalRule,
          surface: "transparent",
          surfaceLight: blockquoteBackground,
          accent: link,
          tableBorder: horizontalRule,
          tableHeader: blockquoteBackground,
          tableHeaderText: strong,
          tableRowOdd: blockquoteBackground,
          tableRowEven: "transparent",
          code: codeText,
          codeBackground,
        },
      },
      styles: {
        text: {
          color: body,
          fontFamily: regularFontFamily,
          fontSize: markdownFontSizes.m,
          lineHeight: markdownFontSizes.bodyLineHeight,
        },
        heading: {
          color: strong,
          fontFamily: boldFontFamily,
        },
        strong: {
          color: strong,
          fontFamily: boldFontFamily,
        },
        link: {
          color: link,
          fontFamily: mediumFontFamily,
        },
        blockquote: {
          backgroundColor: blockquoteBackground,
          borderLeftColor: blockquoteBorder,
          borderLeftWidth: 3,
          paddingLeft: 12,
        },
        code: {
          backgroundColor: codeBackground,
          color: codeText,
          fontFamily: "ui-monospace",
        },
        codeBlock: {
          backgroundColor: codeBackground,
          borderRadius: 12,
          color: codeText,
          fontFamily: "ui-monospace",
          padding: 12,
        },
        hr: {
          backgroundColor: horizontalRule,
        },
      },
      renderers,
      nativeTextStyle: {
        color: body,
        strongColor: strong,
        mutedColor: body,
        linkColor: link,
        inlineCodeColor: codeText,
        codeColor: codeText,
        codeBackgroundColor: codeBackground,
        codeBlockBackgroundColor: codeBackground,
        fileTextColor: codeText,
        skillTextColor: codeText,
        quoteMarkerColor: blockquoteBorder,
        dividerColor: horizontalRule,
        fontSize: nativeMarkdownTypography.fontSize,
        lineHeight: nativeMarkdownTypography.lineHeight,
        headingFontSizes: nativeMarkdownTypography.headingFontSizes,
        fontFamily: regularFontFamily,
        headingFontFamily: boldFontFamily,
        boldFontFamily,
      },
    };
  }, [
    blockquoteBackground,
    blockquoteBorder,
    body,
    codeBackground,
    codeText,
    horizontalRule,
    link,
    markdownFontSizes,
    mediumFontFamily,
    nativeMarkdownTypography,
    regularFontFamily,
    strong,
    boldFontFamily,
  ]);
}

/**
 * Renders untrusted markdown with the app's shared markdown theme, using the
 * native selectable renderer where it exists and the JS renderer elsewhere.
 */
export function MarkdownBlock(props: { readonly markdown: string }) {
  const styles = useMarkdownBlockStyles();
  const onLinkPress = useCallback((href: string) => {
    void tryOpenExternalUrl(href, "markdown-link");
  }, []);

  if (hasNativeSelectableMarkdownText()) {
    return (
      <SelectableMarkdownText
        markdown={props.markdown}
        onLinkPress={onLinkPress}
        textStyle={styles.nativeTextStyle}
      />
    );
  }

  return (
    <Markdown
      options={{ gfm: true }}
      renderers={styles.renderers}
      styles={styles.styles}
      theme={styles.theme}
    >
      {props.markdown}
    </Markdown>
  );
}
