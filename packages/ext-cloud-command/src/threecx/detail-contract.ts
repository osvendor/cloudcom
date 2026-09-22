/** Browser-safe projections only. No credentials, provisioning URLs, or PINs. */
export type DetailValue = string | number | boolean | null;
export type DetailFields = Record<string, DetailValue>;
export type ForwardingProfile = {
  Id: number; Name: string; fields: DetailFields;
  destinations: { label: string; type: string; target: string | null }[];
};
export type ThreeCxDetail = {
  user: DetailFields & { Id: number; Number: string };
  groups: { id: number; name: string; role: string | null }[];
  phones: { id: number; name: string; macAddress: string | null; template: string | null; interface: string | null }[];
  forwardingProfiles: ForwardingProfile[];
  forwardingExceptions: { id: number; fields: DetailFields; destination: string | null }[];
  greetings: { name: string; profile: string | null }[];
  blf: { configured: boolean; entries: { position: number; type: string; target: string; label: string }[]; readable: boolean };
  revision: string;
  editable: { general: boolean; voicemail: boolean; forwarding: boolean };
  notices: string[];
};
export type ThreeCxDetailChanges = {
  FirstName?: string; LastName?: string; EmailAddress?: string; Mobile?: string; OutboundCallerID?: string;
  VMEnabled?: boolean; VMEmailOptions?: 'None' | 'Notification' | 'Attachment' | 'AttachmentAndDelete';
  VMPlayCallerID?: boolean; VMPlayMsgDateTime?: 'None' | 'Play12Hr' | 'Play24Hr';
  ForwardingProfiles?: {
    Id: number; NoAnswerTimeout?: number; RingMyMobile?: boolean; AcceptMultipleCalls?: boolean;
    BlockPushCalls?: boolean; DisableRingGroupCalls?: boolean; OfficeHoursAutoQueueLogOut?: boolean;
  }[];
};
