/** Personal conversation shortcuts, scoped to a viewer and client. */
export interface NavigationPin {
  kind: 'room' | 'dm';
  projectId: string;
  itemId: string;
  label: string;
  pinnedAt: number;
}
export type NavigationPinTarget = Pick<NavigationPin, 'kind' | 'projectId' | 'itemId'>;
export const navigationPinKey = (pin: NavigationPinTarget): string => `${pin.kind}:${pin.itemId}`;
