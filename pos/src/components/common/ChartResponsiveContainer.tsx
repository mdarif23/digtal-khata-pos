import {
  ResponsiveContainer as RechartsResponsiveContainer,
} from "recharts";
import type { ComponentProps } from "react";

type Props = ComponentProps<typeof RechartsResponsiveContainer>;

export function ChartResponsiveContainer(props: Props) {
  return (
    <RechartsResponsiveContainer
      initialDimension={{ width: 1, height: 1 }}
      {...props}
    />
  );
}
