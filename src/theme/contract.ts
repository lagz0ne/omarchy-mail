import { data, remoteData } from "@tinkered/core";

export const themeCss = data({ label: "theme.css", initial: "" });

export const themeBoard = remoteData({ themeCss });
