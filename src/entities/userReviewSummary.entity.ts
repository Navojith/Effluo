import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  OneToOne,
  Relation,
} from 'typeorm';
import { Repo } from './repo.entity.ts';
import { FrequencySummaryResultForEachRepo } from '../types/analyze-reviewers';

@Entity()
export class UserReviewSummary {
  @PrimaryGeneratedColumn()
  id?: number;

  @Column({ type: 'jsonb', nullable: false, default: {} })
  review_summary!: FrequencySummaryResultForEachRepo;

  @OneToOne(() => Repo, (repo) => repo.user_review_summary, {
    cascade: false,
  })
  repo!: Relation<Repo>;
}