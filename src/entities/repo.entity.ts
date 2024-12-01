import { Entity, Column, ManyToOne, OneToOne, Relation } from 'typeorm';
import { Owner } from './owner.entity.ts';
import { UserReviewSummary } from './userReviewSummary.entity.ts';

@Entity()
export class Repo {
  @Column({ type: 'varchar', primary: true, nullable: false })
  id!: string;

  @Column({ type: 'varchar', nullable: false })
  full_name!: string;

  @Column({ type: 'varchar', nullable: false })
  url!: string;

  @ManyToOne(() => Owner, (owner) => owner.repos, {
    cascade: false,
  })
  owner!: Owner;

  @OneToOne(() => UserReviewSummary, (summary) => summary.repo, {
    cascade: true,
    nullable: true,
  })
  user_review_summary!: Relation<UserReviewSummary> | null;
}