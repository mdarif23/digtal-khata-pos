import api from "../../../api/axios.js";

export interface SpeedKeyTile {
  variantId: number;
  label: string;
  color: string;
  sortOrder: number;
}

export interface SpeedKeyVariantInfo {
  variantId: number;
  label: string;
  price: number;
  stock: number | null;
}

export async function getSpeedKeysApi(): Promise<SpeedKeyTile[]> {
  const res = await api.get<{ success: boolean; data: SpeedKeyTile[] }>(
    "/speed-keys",
  );
  return res.data.data;
}

export async function saveSpeedKeysApi(tiles: SpeedKeyTile[]): Promise<SpeedKeyTile[]> {
  const res = await api.put<{ success: boolean; data: SpeedKeyTile[] }>(
    "/speed-keys",
    { scopeType: "user", tiles },
  );
  return res.data.data;
}

export const TILE_COLORS = [
  "slate",
  "blue",
  "green",
  "amber",
  "red",
  "purple",
  "teal",
] as const;

export const TILE_COLOR_CLASS: Record<string, string> = {
  slate: "bg-slate-100 hover:bg-slate-200 border-slate-300 text-slate-800",
  blue: "bg-blue-100 hover:bg-blue-200 border-blue-300 text-blue-900",
  green: "bg-green-100 hover:bg-green-200 border-green-300 text-green-900",
  amber: "bg-amber-100 hover:bg-amber-200 border-amber-300 text-amber-900",
  red: "bg-red-100 hover:bg-red-200 border-red-300 text-red-900",
  purple: "bg-purple-100 hover:bg-purple-200 border-purple-300 text-purple-900",
  teal: "bg-teal-100 hover:bg-teal-200 border-teal-300 text-teal-900",
};
