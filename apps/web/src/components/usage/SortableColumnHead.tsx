import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import type { UsageSort } from "@t3tools/client-runtime/usageDashboard";

import { cn } from "~/lib/utils";
import { TableHead } from "../ui/table";

/** Header-click sortable column head shared by the usage dashboard tables. */
export function SortableColumnHead<Column extends string>({
  label,
  column,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  column: Column;
  sort: UsageSort<Column>;
  onSort: (column: Column) => void;
  align?: "left" | "right";
}) {
  const active = sort.column === column;
  const Icon = sort.direction === "asc" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <TableHead
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      className={cn("p-0", align === "right" && "text-right")}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "inline-flex h-10 w-full items-center gap-1 px-2 font-medium hover:text-foreground",
          align === "right" ? "justify-end" : "justify-start",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        <Icon className={cn("size-3 shrink-0", !active && "invisible")} aria-hidden />
      </button>
    </TableHead>
  );
}
