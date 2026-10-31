import {DeepSeekHarnessAdapter,DSH_ADAPTER_VERSION,deepseekHarnessCapabilities} from '../adapter/deepseekHarness/adapter.ts';
import {PiAdapter,PI_ADAPTER_VERSION,piCapabilities} from '../adapter/pi/adapter.ts';
import type {CliAdapterOptions} from '../adapter/cli/turnAdapter.ts';
import type {ExternalRuntimeKind} from '../adapter/cli/executable.ts';
import {isRealRuntimeKind} from '../contracts/runtimeKinds.ts';

/** Native-full CLI transports share plumbing; Claude/Codex keep their own policies. */
const channels={
  'deepseek-harness':{Adapter:DeepSeekHarnessAdapter,version:DSH_ADAPTER_VERSION,capabilities:deepseekHarnessCapabilities,label:'DeepSeek Harness'},
  pi:{Adapter:PiAdapter,version:PI_ADAPTER_VERSION,capabilities:piCapabilities,label:'Pi'},
} as const;
export function isExternalRuntimeKind(kind:unknown):kind is ExternalRuntimeKind{
  return isRealRuntimeKind(kind)&&Object.hasOwn(channels,kind);
}
export function externalRuntimeMetadata(kind:ExternalRuntimeKind){return channels[kind];}
export function externalRuntimeAdapter(kind:ExternalRuntimeKind,options:CliAdapterOptions={}){
  return new channels[kind].Adapter(options);
}
