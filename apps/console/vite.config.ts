import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// base "./" → the built console works from any static host, a file path, or the local MCP adapter.
export default defineConfig({ plugins: [react()], base: "./", build: { target: "es2022" } });
