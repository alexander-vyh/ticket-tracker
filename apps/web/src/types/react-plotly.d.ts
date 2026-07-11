declare module 'react-plotly.js' {
  import type { Component } from 'react';

  interface PlotParams {
    data: Array<Record<string, unknown>>;
    layout?: Record<string, unknown>;
    config?: Record<string, unknown>;
    style?: React.CSSProperties;
    className?: string;
    onClick?: (data: { points: Array<{ customdata?: unknown }> }) => void;
    onHover?: (data: unknown) => void;
  }

  class Plot extends Component<PlotParams> {}
  export default Plot;
}
