import type { Skill as SkillMount } from '@truefoundry/trueforge-core/core';
import { resolveGitTurnSkills, validateGitAgentSkills } from '../db/gitSkillMounts';
import type {
  AgentSkillsInput,
  CreateSkillInput,
  GetSkillInput,
  ISkillStore,
  ListSkillsInput,
  SkillRecord,
  UpsertSkillInput,
} from '../db/skillStore';
import type { SkillVersion } from '../schemas/skill';
import type { InlineSkills } from './inlineResources';

/**
 * Serves the skills a request brought with it, and delegates everything else.
 *
 * Mirrors {@link InlineMcpServerStore}: name-filtered list is overlaid, an unfiltered list passes
 * through so request-scoped skills stay out of the tenant's settings, and writes delegate because
 * there is no row to write.
 */
export class InlineSkillStore<TTransaction = never> implements ISkillStore<TTransaction> {
  readonly #inner: ISkillStore<TTransaction>;
  readonly #inline: InlineSkills;

  constructor(input: { inner: ISkillStore<TTransaction>; inline: InlineSkills }) {
    this.#inner = input.inner;
    this.#inline = input.inline;
  }

  async listSkills(input: ListSkillsInput, transaction?: TTransaction): Promise<SkillRecord[]> {
    if (input.names === undefined) {
      return this.#inner.listSkills(input, transaction);
    }

    const inlineRecords = input.names
      .map(name => this.#toRecord(input.tenant_id, name))
      .filter((record): record is SkillRecord => record !== undefined);
    const registryNames = input.names.filter(name => this.#inline[name] === undefined);
    const registryRecords =
      registryNames.length > 0 ? await this.#inner.listSkills({ ...input, names: registryNames }, transaction) : [];

    return [...inlineRecords, ...registryRecords];
  }

  async validateAgentSkills(input: AgentSkillsInput, transaction?: TTransaction): Promise<void> {
    const inlineSkills = input.skills.filter(skill => this.#inline[skill.name] !== undefined);
    const registrySkills = input.skills.filter(skill => this.#inline[skill.name] === undefined);
    if (inlineSkills.length > 0) {
      await validateGitAgentSkills(this, { tenant_id: input.tenant_id, skills: inlineSkills });
    }
    if (registrySkills.length > 0) {
      await this.#inner.validateAgentSkills({ tenant_id: input.tenant_id, skills: registrySkills }, transaction);
    }
  }

  async resolveTurnSkills(input: AgentSkillsInput): Promise<SkillMount[]> {
    const inlineSkills = input.skills.filter(skill => this.#inline[skill.name] !== undefined);
    const registrySkills = input.skills.filter(skill => this.#inline[skill.name] === undefined);
    const mounts: SkillMount[] = [];
    if (inlineSkills.length > 0) {
      mounts.push(...(await resolveGitTurnSkills(this, { tenant_id: input.tenant_id, skills: inlineSkills })));
    }
    if (registrySkills.length > 0) {
      mounts.push(...(await this.#inner.resolveTurnSkills({ tenant_id: input.tenant_id, skills: registrySkills })));
    }
    return mounts;
  }

  createSkill(input: CreateSkillInput, transaction?: TTransaction): Promise<SkillRecord> {
    return this.#inner.createSkill(input, transaction);
  }

  upsertSkill(input: UpsertSkillInput, transaction?: TTransaction): Promise<SkillRecord> {
    return this.#inner.upsertSkill(input, transaction);
  }

  deleteSkill(input: GetSkillInput, transaction?: TTransaction): Promise<void> {
    return this.#inner.deleteSkill(input, transaction);
  }

  listSkillVersions(input: { name: string }): Promise<SkillVersion[]> {
    return this.#inner.listSkillVersions(input);
  }

  #toRecord(tenant_id: string, name: string): SkillRecord | undefined {
    const manifest = this.#inline[name];
    if (manifest === undefined) {
      return undefined;
    }
    const now = new Date().toISOString();
    return { tenant_id, name, manifest, created_at: now, updated_at: now };
  }
}
