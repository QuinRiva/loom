import type { ThreadSearchFilters } from "@t3tools/client-runtime/state/loom/threadSearch";
import type { ProjectId } from "@t3tools/contracts";
import { ScrollView } from "react-native";

import { Chip } from "../../components/ui/Chip";

/**
 * The search field's switches, shown while it holds text. `project` is what the project chip
 * offers (the iPad palette's current project); the lists leave it out, their picker is the project switch.
 */
export function ThreadSearchFilterChips(props: {
  readonly filters: ThreadSearchFilters;
  readonly onChange: (filters: ThreadSearchFilters) => void;
  readonly project?: { readonly label: string; readonly projectIds: ReadonlyArray<ProjectId> };
  /** Where the first chip starts, to line up with the rows below. */
  readonly inset: number;
}) {
  const { filters, onChange, project } = props;
  const { projectIds: _projectIds, ...withoutProject } = filters;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        paddingHorizontal: props.inset,
        paddingBottom: 8,
        gap: 8,
        alignItems: "center",
      }}
    >
      <Chip
        label="Sub-threads"
        accessibilityLabel="Include sub-threads"
        selected={filters.subThreads}
        onPress={() => onChange({ ...filters, subThreads: !filters.subThreads })}
      />
      <Chip
        label="Archived"
        accessibilityLabel="Include archived threads"
        selected={filters.archived}
        onPress={() => onChange({ ...filters, archived: !filters.archived })}
      />
      {project === undefined ? null : (
        <Chip
          label={project.label}
          icon="folder.fill"
          accessibilityLabel={`Only ${project.label}`}
          selected={filters.projectIds !== undefined}
          onPress={() =>
            onChange(
              filters.projectIds === undefined
                ? { ...filters, projectIds: project.projectIds }
                : withoutProject,
            )
          }
        />
      )}
    </ScrollView>
  );
}
