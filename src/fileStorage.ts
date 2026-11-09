import { invoke } from "@tauri-apps/api/core";
import { createJSONStorage, type StateStorage } from "zustand/middleware";

/** zustand "persist" storage backed by small files in the app data folder (see settings_get/set). */
const files: StateStorage = {
  getItem: (name) => invoke<string | null>("settings_get", { name }).catch(() => null),
  setItem: (name, value) => invoke<void>("settings_set", { name, value }).catch(() => {}),
  removeItem: (name) => invoke<void>("settings_remove", { name }).catch(() => {}),
};

export const fileStorage = createJSONStorage(() => files);
