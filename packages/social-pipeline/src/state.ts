import type { Persona, Campaign, Piece } from "./schemas/index.js";

export interface SocialState {
  persona: Persona;
  campaign: Campaign;
  piece: Piece;
  asset_pool_summary: {
    refs_last_refreshed: string | null;
    reference_post_count: number;
  };
}

export function initSocialState(input: { persona: Persona; campaign: Campaign; piece: Piece }): SocialState {
  return {
    persona: input.persona,
    campaign: input.campaign,
    piece: input.piece,
    asset_pool_summary: {
      refs_last_refreshed: null,
      reference_post_count: 0,
    },
  };
}
