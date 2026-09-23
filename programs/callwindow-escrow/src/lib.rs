use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("GxX6X6zZSQSuxEoTHPwaAmKCcpGRVRiB6ERANHzS7Eq9");

pub const MAX_ORDERS: usize = 32;
pub const MAX_CANDIDATE_TICKS: u8 = 101;
pub const PRICE_TICK_CENTS: u16 = 1;
pub const MAX_ORDER_BASE_UNITS: u64 = 10_000;
pub const MAX_PRICE_CENTS: u16 = 10_000;
pub const ABORT_GRACE_SECONDS: i64 = 30 * 60;
pub const MIN_WINDOW_SECONDS: i64 = 10;

pub const SIDE_BUY: u8 = 0;
pub const SIDE_SELL: u8 = 1;

const AUCTION_OPEN: u8 = 0;
const AUCTION_CLOSED: u8 = 1;
const AUCTION_HALTED: u8 = 2;
const AUCTION_ABORTED: u8 = 3;
const ORDER_ACTIVE: u8 = 0;
const ORDER_CANCELLED: u8 = 1;

#[program]
pub mod callwindow_escrow {
    use super::*;

    pub fn create_auction(
        ctx: Context<CreateAuction>,
        auction_id: u64,
        first_tick_cents: u16,
        candidate_tick_count: u8,
        opening_reference_cents: u16,
        cutoff_time: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        validate_grid(
            first_tick_cents,
            candidate_tick_count,
            opening_reference_cents,
        )?;
        require!(
            cutoff_time >= now + MIN_WINDOW_SECONDS,
            AuctionError::CutoffTooSoon
        );
        require!(
            ctx.accounts.base_mint.decimals == 2,
            AuctionError::WrongBaseDecimals
        );
        require!(
            ctx.accounts.quote_mint.decimals == 6,
            AuctionError::WrongQuoteDecimals
        );

        let auction = &mut ctx.accounts.auction;
        auction.authority = ctx.accounts.authority.key();
        auction.base_mint = ctx.accounts.base_mint.key();
        auction.quote_mint = ctx.accounts.quote_mint.key();
        auction.base_vault = ctx.accounts.base_vault.key();
        auction.quote_vault = ctx.accounts.quote_vault.key();
        auction.auction_id = auction_id;
        auction.cutoff_time = cutoff_time;
        auction.abort_after = cutoff_time
            .checked_add(ABORT_GRACE_SECONDS)
            .ok_or(AuctionError::InvalidCutoff)?;
        auction.opening_reference_cents = opening_reference_cents;
        auction.first_tick_cents = first_tick_cents;
        auction.candidate_tick_count = candidate_tick_count;
        auction.order_count = 0;
        auction.state = AUCTION_OPEN;
        auction.clearing_price_cents = 0;
        auction.matched_base = 0;
        auction.claimed_count = 0;
        auction.bump = ctx.bumps.auction;
        auction.vault_bump = ctx.bumps.vault_authority;
        auction.orders = vec![Order::default(); MAX_ORDERS];
        Ok(())
    }

    pub fn place_order(
        ctx: Context<PlaceOrder>,
        side: u8,
        limit_price_cents: u16,
        quantity_base_units: u64,
    ) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        let now = Clock::get()?.unix_timestamp;
        require!(auction.state == AUCTION_OPEN, AuctionError::AuctionNotOpen);
        require!(now < auction.cutoff_time, AuctionError::WindowClosed);
        require!(
            side == SIDE_BUY || side == SIDE_SELL,
            AuctionError::InvalidSide
        );
        require!(quantity_base_units > 0, AuctionError::ZeroQuantity);
        require!(
            quantity_base_units <= MAX_ORDER_BASE_UNITS,
            AuctionError::OrderTooLarge
        );
        require!(
            has_order_capacity(auction.order_count),
            AuctionError::TooManyOrders
        );
        require!(
            valid_price(auction, limit_price_cents),
            AuctionError::PriceOutOfRange
        );

        let escrowed_quote = if side == SIDE_BUY {
            payment_for(quantity_base_units, limit_price_cents)?
        } else {
            0
        };
        if side == SIDE_BUY {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.user_quote.to_account_info(),
                        to: ctx.accounts.quote_vault.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                escrowed_quote,
            )?;
        } else {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.user_base.to_account_info(),
                        to: ctx.accounts.base_vault.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                quantity_base_units,
            )?;
        }

        let index = auction.order_count as usize;
        auction.orders[index] = Order {
            owner: ctx.accounts.user.key(),
            side,
            status: ORDER_ACTIVE,
            limit_price_cents,
            quantity_base_units,
            escrowed_quote,
            filled_base_units: 0,
            claimed: false,
        };
        auction.order_count += 1;
        Ok(())
    }

    pub fn cancel_order(ctx: Context<CancelOrder>, order_index: u8) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        let now = Clock::get()?.unix_timestamp;
        require!(auction.state == AUCTION_OPEN, AuctionError::AuctionNotOpen);
        require!(now < auction.cutoff_time, AuctionError::WindowClosed);
        let index = order_index as usize;
        require!(
            index < auction.order_count as usize,
            AuctionError::OrderNotFound
        );
        let order = auction.orders[index];
        require_keys_eq!(
            order.owner,
            ctx.accounts.user.key(),
            AuctionError::WrongOrderOwner
        );
        let (base_refund, quote_refund) =
            cancel_refund(&order).ok_or(AuctionError::OrderNotCancellable)?;

        let auction_key = auction.key();
        let bump = [auction.vault_bump];
        let signer_seeds: &[&[u8]] = &[b"vault", auction_key.as_ref(), &bump];
        let signer = &[signer_seeds];
        if base_refund > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.base_vault.to_account_info(),
                        to: ctx.accounts.user_base.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    signer,
                ),
                base_refund,
            )?;
        }
        if quote_refund > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.quote_vault.to_account_info(),
                        to: ctx.accounts.user_quote.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    signer,
                ),
                quote_refund,
            )?;
        }
        auction.orders[index].status = ORDER_CANCELLED;
        auction.orders[index].claimed = true;
        Ok(())
    }

    pub fn close_auction(ctx: Context<PermissionlessAuctionAction>) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        require!(auction.state == AUCTION_OPEN, AuctionError::AuctionNotOpen);
        require!(
            Clock::get()?.unix_timestamp >= auction.cutoff_time,
            AuctionError::WindowStillOpen
        );
        apply_close(auction);
        Ok(())
    }

    pub fn halt_auction(ctx: Context<HaltAuction>) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        require_keys_eq!(
            auction.authority,
            ctx.accounts.authority.key(),
            AuctionError::WrongAuthority
        );
        require!(
            auction.state == AUCTION_OPEN || auction.state == AUCTION_CLOSED,
            AuctionError::AuctionAlreadyRefundable
        );
        require!(
            auction.claimed_count == 0,
            AuctionError::ClaimsAlreadyStarted
        );
        halt(auction);
        Ok(())
    }

    pub fn abort_auction(ctx: Context<PermissionlessAuctionAction>) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        let now = Clock::get()?.unix_timestamp;
        require!(
            abort_available(auction, now),
            AuctionError::AbortNotAvailable
        );
        auction.state = AUCTION_ABORTED;
        auction.clearing_price_cents = 0;
        auction.matched_base = 0;
        let order_count = auction.order_count as usize;
        for order in auction.orders.iter_mut().take(order_count) {
            if !order.claimed {
                order.filled_base_units = 0;
            }
        }
        Ok(())
    }

    pub fn claim_order(ctx: Context<ClaimOrder>, order_index: u8) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        require!(
            auction.state == AUCTION_CLOSED
                || auction.state == AUCTION_HALTED
                || auction.state == AUCTION_ABORTED,
            AuctionError::AuctionNotClaimable
        );
        let index = order_index as usize;
        require!(
            index < auction.order_count as usize,
            AuctionError::OrderNotFound
        );
        let order = auction.orders[index];
        require!(
            !order.claimed && order.status == ORDER_ACTIVE,
            AuctionError::AlreadyClaimed
        );
        require_keys_eq!(
            order.owner,
            ctx.accounts.owner.key(),
            AuctionError::WrongClaimOwner
        );
        let (base_out, quote_out) =
            claim_amounts(&order, auction.state, auction.clearing_price_cents)
                .ok_or(AuctionError::InvalidSettlement)?;

        let auction_key = auction.key();
        let bump = [auction.vault_bump];
        let signer_seeds: &[&[u8]] = &[b"vault", auction_key.as_ref(), &bump];
        let signer = &[signer_seeds];
        if base_out > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.base_vault.to_account_info(),
                        to: ctx.accounts.owner_base.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    signer,
                ),
                base_out,
            )?;
        }
        if quote_out > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.quote_vault.to_account_info(),
                        to: ctx.accounts.owner_quote.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    signer,
                ),
                quote_out,
            )?;
        }
        auction.orders[index].claimed = true;
        auction.claimed_count = auction.claimed_count.saturating_add(1);
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(auction_id: u64)]
pub struct CreateAuction<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = Auction::SPACE,
        seeds = [b"auction", authority.key().as_ref(), auction_id.to_le_bytes().as_ref()],
        bump
    )]
    pub auction: Account<'info, Auction>,
    pub base_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,
    /// CHECK: This PDA is the token authority for the auction vault accounts.
    #[account(seeds = [b"vault", auction.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = base_mint,
        associated_token::authority = vault_authority
    )]
    pub base_vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = quote_mint,
        associated_token::authority = vault_authority
    )]
    pub quote_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    #[account(
        mut,
        seeds = [b"auction", auction.authority.as_ref(), auction.auction_id.to_le_bytes().as_ref()],
        bump = auction.bump
    )]
    pub auction: Account<'info, Auction>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(address = auction.base_mint)]
    pub base_mint: Account<'info, Mint>,
    #[account(address = auction.quote_mint)]
    pub quote_mint: Account<'info, Mint>,
    #[account(mut, token::mint = base_mint, token::authority = user)]
    pub user_base: Account<'info, TokenAccount>,
    #[account(mut, token::mint = quote_mint, token::authority = user)]
    pub user_quote: Account<'info, TokenAccount>,
    /// CHECK: The PDA is checked against this auction and stored bump.
    #[account(seeds = [b"vault", auction.key().as_ref()], bump = auction.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, address = auction.base_vault, token::mint = base_mint, token::authority = vault_authority)]
    pub base_vault: Account<'info, TokenAccount>,
    #[account(mut, address = auction.quote_vault, token::mint = quote_mint, token::authority = vault_authority)]
    pub quote_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(
        mut,
        seeds = [b"auction", auction.authority.as_ref(), auction.auction_id.to_le_bytes().as_ref()],
        bump = auction.bump
    )]
    pub auction: Account<'info, Auction>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(address = auction.base_mint)]
    pub base_mint: Account<'info, Mint>,
    #[account(address = auction.quote_mint)]
    pub quote_mint: Account<'info, Mint>,
    #[account(mut, token::mint = base_mint, token::authority = user)]
    pub user_base: Account<'info, TokenAccount>,
    #[account(mut, token::mint = quote_mint, token::authority = user)]
    pub user_quote: Account<'info, TokenAccount>,
    /// CHECK: The PDA is checked against this auction and stored bump.
    #[account(seeds = [b"vault", auction.key().as_ref()], bump = auction.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, address = auction.base_vault, token::mint = base_mint, token::authority = vault_authority)]
    pub base_vault: Account<'info, TokenAccount>,
    #[account(mut, address = auction.quote_vault, token::mint = quote_mint, token::authority = vault_authority)]
    pub quote_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PermissionlessAuctionAction<'info> {
    #[account(
        mut,
        seeds = [b"auction", auction.authority.as_ref(), auction.auction_id.to_le_bytes().as_ref()],
        bump = auction.bump
    )]
    pub auction: Account<'info, Auction>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct HaltAuction<'info> {
    #[account(
        mut,
        seeds = [b"auction", auction.authority.as_ref(), auction.auction_id.to_le_bytes().as_ref()],
        bump = auction.bump
    )]
    pub auction: Account<'info, Auction>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimOrder<'info> {
    #[account(
        mut,
        seeds = [b"auction", auction.authority.as_ref(), auction.auction_id.to_le_bytes().as_ref()],
        bump = auction.bump
    )]
    pub auction: Account<'info, Auction>,
    /// CHECK: Must match the stored order owner and both destination token authorities.
    pub owner: UncheckedAccount<'info>,
    #[account(address = auction.base_mint)]
    pub base_mint: Account<'info, Mint>,
    #[account(address = auction.quote_mint)]
    pub quote_mint: Account<'info, Mint>,
    #[account(mut, token::mint = base_mint, token::authority = owner)]
    pub owner_base: Account<'info, TokenAccount>,
    #[account(mut, token::mint = quote_mint, token::authority = owner)]
    pub owner_quote: Account<'info, TokenAccount>,
    /// CHECK: The PDA is checked against this auction and stored bump.
    #[account(seeds = [b"vault", auction.key().as_ref()], bump = auction.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, address = auction.base_vault, token::mint = base_mint, token::authority = vault_authority)]
    pub base_vault: Account<'info, TokenAccount>,
    #[account(mut, address = auction.quote_vault, token::mint = quote_mint, token::authority = vault_authority)]
    pub quote_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct Auction {
    pub authority: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub auction_id: u64,
    pub cutoff_time: i64,
    pub abort_after: i64,
    pub opening_reference_cents: u16,
    pub first_tick_cents: u16,
    pub candidate_tick_count: u8,
    pub order_count: u8,
    pub state: u8,
    pub clearing_price_cents: u16,
    pub matched_base: u64,
    pub claimed_count: u8,
    pub bump: u8,
    pub vault_bump: u8,
    pub orders: Vec<Order>,
}

impl Auction {
    pub const HEADER_SPACE: usize = 5 * 32 + 4 * 8 + 3 * 2 + 6;
    pub const SPACE: usize = 8 + Self::HEADER_SPACE + 4 + MAX_ORDERS * Order::SPACE;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct Order {
    pub owner: Pubkey,
    pub side: u8,
    pub status: u8,
    pub limit_price_cents: u16,
    pub quantity_base_units: u64,
    pub escrowed_quote: u64,
    pub filled_base_units: u64,
    pub claimed: bool,
}

impl Order {
    pub const SPACE: usize = 32 + 1 + 1 + 2 + 8 + 8 + 8 + 1;
}

#[derive(Clone, Copy)]
struct Candidate {
    price_cents: u16,
    matched_base_units: u64,
    imbalance: u64,
    distance_from_reference: u16,
}

fn valid_price(auction: &Auction, price_cents: u16) -> bool {
    let Some(last_tick) = auction
        .first_tick_cents
        .checked_add(auction.candidate_tick_count.saturating_sub(1) as u16 * PRICE_TICK_CENTS)
    else {
        return false;
    };
    auction.candidate_tick_count > 0
        && auction.candidate_tick_count <= MAX_CANDIDATE_TICKS
        && price_cents >= auction.first_tick_cents
        && price_cents <= last_tick
        && last_tick <= MAX_PRICE_CENTS
}

fn has_order_capacity(order_count: u8) -> bool {
    (order_count as usize) < MAX_ORDERS
}

fn supported_order_count(order_count: u8) -> bool {
    (order_count as usize) <= MAX_ORDERS
}

fn validate_grid(
    first_tick_cents: u16,
    candidate_tick_count: u8,
    reference_cents: u16,
) -> Result<()> {
    require!(candidate_tick_count > 0, AuctionError::InvalidPriceGrid);
    require!(
        candidate_tick_count <= MAX_CANDIDATE_TICKS,
        AuctionError::TooManyTicks
    );
    let tick_span = (candidate_tick_count - 1) as u16 * PRICE_TICK_CENTS;
    let last_tick = first_tick_cents
        .checked_add(tick_span)
        .ok_or(AuctionError::InvalidPriceGrid)?;
    require!(
        first_tick_cents > 0 && last_tick <= MAX_PRICE_CENTS,
        AuctionError::InvalidPriceGrid
    );
    require!(
        reference_cents >= first_tick_cents && reference_cents <= last_tick,
        AuctionError::InvalidReference
    );
    Ok(())
}

fn payment_for(base_units: u64, price_cents: u16) -> Result<u64> {
    let value = (base_units as u128)
        .checked_mul(price_cents as u128)
        .and_then(|amount| amount.checked_mul(100))
        .ok_or(AuctionError::AmountOverflow)?;
    u64::try_from(value).map_err(|_| error!(AuctionError::AmountOverflow))
}

fn cancel_refund(order: &Order) -> Option<(u64, u64)> {
    if order.status != ORDER_ACTIVE || order.claimed {
        return None;
    }
    match order.side {
        SIDE_BUY => Some((0, order.escrowed_quote)),
        SIDE_SELL => Some((order.quantity_base_units, 0)),
        _ => None,
    }
}

fn claim_amounts(
    order: &Order,
    auction_state: u8,
    clearing_price_cents: u16,
) -> Option<(u64, u64)> {
    if order.status != ORDER_ACTIVE || order.claimed {
        return None;
    }
    match auction_state {
        AUCTION_HALTED | AUCTION_ABORTED => match order.side {
            SIDE_BUY => Some((0, order.escrowed_quote)),
            SIDE_SELL => Some((order.quantity_base_units, 0)),
            _ => None,
        },
        AUCTION_CLOSED => {
            if order.filled_base_units > order.quantity_base_units {
                return None;
            }
            let payment = payment_for(order.filled_base_units, clearing_price_cents).ok()?;
            match order.side {
                SIDE_BUY => Some((
                    order.filled_base_units,
                    order.escrowed_quote.checked_sub(payment)?,
                )),
                SIDE_SELL => Some((order.quantity_base_units - order.filled_base_units, payment)),
                _ => None,
            }
        }
        _ => None,
    }
}

fn valid_reference(auction: &Auction) -> bool {
    valid_price(auction, auction.opening_reference_cents)
}

fn select_candidate(auction: &Auction) -> Option<Candidate> {
    if !supported_order_count(auction.order_count)
        || auction.candidate_tick_count == 0
        || auction.candidate_tick_count > MAX_CANDIDATE_TICKS
        || !valid_reference(auction)
    {
        return None;
    }

    let mut best: Option<Candidate> = None;
    for tick_index in 0..auction.candidate_tick_count {
        let price_cents = auction
            .first_tick_cents
            .checked_add(tick_index as u16 * PRICE_TICK_CENTS)?;
        let mut buy_quantity = 0u128;
        let mut sell_quantity = 0u128;
        for order in auction.orders.iter().take(auction.order_count as usize) {
            if order.status != ORDER_ACTIVE {
                continue;
            }
            if order.side == SIDE_BUY && order.limit_price_cents >= price_cents {
                buy_quantity += order.quantity_base_units as u128;
            } else if order.side == SIDE_SELL && order.limit_price_cents <= price_cents {
                sell_quantity += order.quantity_base_units as u128;
            }
        }
        let buy_quantity = u64::try_from(buy_quantity).ok()?;
        let sell_quantity = u64::try_from(sell_quantity).ok()?;
        let candidate = Candidate {
            price_cents,
            matched_base_units: buy_quantity.min(sell_quantity),
            imbalance: buy_quantity.abs_diff(sell_quantity),
            distance_from_reference: price_cents.abs_diff(auction.opening_reference_cents),
        };
        if best
            .map(|current| candidate_is_better(candidate, current))
            .unwrap_or(true)
        {
            best = Some(candidate);
        }
    }
    best
}

fn candidate_is_better(candidate: Candidate, current: Candidate) -> bool {
    candidate.matched_base_units > current.matched_base_units
        || (candidate.matched_base_units == current.matched_base_units
            && (candidate.imbalance < current.imbalance
                || (candidate.imbalance == current.imbalance
                    && (candidate.distance_from_reference < current.distance_from_reference
                        || (candidate.distance_from_reference
                            == current.distance_from_reference
                            && candidate.price_cents < current.price_cents)))))
}

fn allocate_side(
    auction: &Auction,
    side: u8,
    price_cents: u16,
    matched_base_units: u64,
) -> Option<[u64; MAX_ORDERS]> {
    let mut indices = [0u8; MAX_ORDERS];
    let mut count = 0usize;
    for (index, order) in auction
        .orders
        .iter()
        .take(auction.order_count as usize)
        .enumerate()
    {
        if order.status != ORDER_ACTIVE || order.side != side {
            continue;
        }
        let eligible = if side == SIDE_BUY {
            order.limit_price_cents >= price_cents
        } else {
            order.limit_price_cents <= price_cents
        };
        if eligible {
            indices[count] = index as u8;
            count += 1;
        }
    }
    indices[..count].sort_unstable_by(|left, right| {
        let left_index = *left as usize;
        let right_index = *right as usize;
        let left_order = auction.orders[left_index];
        let right_order = auction.orders[right_index];
        let price_order = if side == SIDE_BUY {
            right_order
                .limit_price_cents
                .cmp(&left_order.limit_price_cents)
        } else {
            left_order
                .limit_price_cents
                .cmp(&right_order.limit_price_cents)
        };
        price_order.then_with(|| left.cmp(right))
    });

    let mut fills = [0u64; MAX_ORDERS];
    let mut remaining = matched_base_units;
    for index in indices.iter().take(count) {
        if remaining == 0 {
            break;
        }
        let order_index = *index as usize;
        let fill = auction.orders[order_index]
            .quantity_base_units
            .min(remaining);
        fills[order_index] = fill;
        remaining -= fill;
    }
    if remaining == 0 {
        Some(fills)
    } else {
        None
    }
}

fn apply_close(auction: &mut Auction) {
    let Some(candidate) = select_candidate(auction) else {
        halt(auction);
        return;
    };
    if candidate.matched_base_units == 0 {
        auction.state = AUCTION_CLOSED;
        auction.clearing_price_cents = 0;
        auction.matched_base = 0;
        return;
    }
    let Some(buy_fills) = allocate_side(
        auction,
        SIDE_BUY,
        candidate.price_cents,
        candidate.matched_base_units,
    ) else {
        halt(auction);
        return;
    };
    let Some(sell_fills) = allocate_side(
        auction,
        SIDE_SELL,
        candidate.price_cents,
        candidate.matched_base_units,
    ) else {
        halt(auction);
        return;
    };
    let buy_total: u64 = buy_fills.iter().sum();
    let sell_total: u64 = sell_fills.iter().sum();
    if buy_total != candidate.matched_base_units || sell_total != candidate.matched_base_units {
        halt(auction);
        return;
    }
    for index in 0..auction.order_count as usize {
        auction.orders[index].filled_base_units = if auction.orders[index].side == SIDE_BUY {
            buy_fills[index]
        } else {
            sell_fills[index]
        };
    }
    auction.state = AUCTION_CLOSED;
    auction.clearing_price_cents = candidate.price_cents;
    auction.matched_base = candidate.matched_base_units;
}

fn halt(auction: &mut Auction) {
    auction.state = AUCTION_HALTED;
    auction.clearing_price_cents = 0;
    auction.matched_base = 0;
    for order in auction
        .orders
        .iter_mut()
        .take(auction.order_count.min(MAX_ORDERS as u8) as usize)
    {
        order.filled_base_units = 0;
    }
}

fn abort_available(auction: &Auction, now: i64) -> bool {
    (auction.state == AUCTION_OPEN
        || auction.state == AUCTION_CLOSED
        || auction.state == AUCTION_HALTED)
        && auction.claimed_count == 0
        && now >= auction.abort_after
}

#[error_code]
pub enum AuctionError {
    #[msg("Auction price grid is invalid")]
    InvalidPriceGrid,
    #[msg("Auction exceeds the 101 candidate-tick cap")]
    TooManyTicks,
    #[msg("Opening reference is outside the candidate grid")]
    InvalidReference,
    #[msg("Cutoff must be at least ten seconds in the future")]
    CutoffTooSoon,
    #[msg("Cutoff time is out of range")]
    InvalidCutoff,
    #[msg("Base demo mint must use two decimals")]
    WrongBaseDecimals,
    #[msg("Quote demo mint must use six decimals")]
    WrongQuoteDecimals,
    #[msg("Auction is not open")]
    AuctionNotOpen,
    #[msg("Order window has closed")]
    WindowClosed,
    #[msg("Order side must be buy or sell")]
    InvalidSide,
    #[msg("Order quantity must be positive")]
    ZeroQuantity,
    #[msg("Order quantity exceeds the 100-share cap")]
    OrderTooLarge,
    #[msg("Auction is at the 32-order cap")]
    TooManyOrders,
    #[msg("Limit price is outside this auction's one-cent grid")]
    PriceOutOfRange,
    #[msg("Order was not found")]
    OrderNotFound,
    #[msg("Only the order owner can cancel it")]
    WrongOrderOwner,
    #[msg("Only the order owner can receive a claim")]
    WrongClaimOwner,
    #[msg("Order is not cancellable")]
    OrderNotCancellable,
    #[msg("Auction window has not reached cutoff")]
    WindowStillOpen,
    #[msg("Only the auction authority can halt it")]
    WrongAuthority,
    #[msg("Auction is already in a refundable state")]
    AuctionAlreadyRefundable,
    #[msg("Claims have already started")]
    ClaimsAlreadyStarted,
    #[msg("Thirty-minute abort is not available")]
    AbortNotAvailable,
    #[msg("Auction is not ready for claims")]
    AuctionNotClaimable,
    #[msg("Order was already claimed")]
    AlreadyClaimed,
    #[msg("Settlement amounts are invalid")]
    InvalidSettlement,
    #[msg("Token amount overflow")]
    AmountOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_auction() -> Auction {
        Auction {
            authority: Pubkey::new_unique(),
            base_mint: Pubkey::new_unique(),
            quote_mint: Pubkey::new_unique(),
            base_vault: Pubkey::new_unique(),
            quote_vault: Pubkey::new_unique(),
            auction_id: 7,
            cutoff_time: 100,
            abort_after: 1_900,
            opening_reference_cents: 150,
            first_tick_cents: 100,
            candidate_tick_count: 101,
            order_count: 0,
            state: AUCTION_OPEN,
            clearing_price_cents: 0,
            matched_base: 0,
            claimed_count: 0,
            bump: 0,
            vault_bump: 0,
            orders: vec![Order::default(); MAX_ORDERS],
        }
    }

    fn add_order(auction: &mut Auction, side: u8, price: u16, quantity: u64) {
        let index = auction.order_count as usize;
        auction.orders[index] = Order {
            owner: Pubkey::new_unique(),
            side,
            status: ORDER_ACTIVE,
            limit_price_cents: price,
            quantity_base_units: quantity,
            escrowed_quote: if side == SIDE_BUY {
                payment_for(quantity, price).unwrap()
            } else {
                0
            },
            filled_base_units: 0,
            claimed: false,
        };
        auction.order_count += 1;
    }

    #[test]
    fn grid_accepts_101_one_cent_ticks_and_rejects_tick_102() {
        assert!(validate_grid(100, MAX_CANDIDATE_TICKS, 150).is_ok());
        assert!(validate_grid(100, MAX_CANDIDATE_TICKS + 1, 150).is_err());
        assert!(validate_grid(100, 0, 100).is_err());
        assert_eq!(PRICE_TICK_CENTS, 1);
    }

    #[test]
    fn order_capacity_stops_at_32_before_a_33rd_order_can_be_added() {
        assert!(has_order_capacity(0));
        assert!(has_order_capacity((MAX_ORDERS - 1) as u8));
        assert!(!has_order_capacity(MAX_ORDERS as u8));
        assert!(supported_order_count(MAX_ORDERS as u8));
        assert!(!supported_order_count(MAX_ORDERS as u8 + 1));
        assert_eq!(new_auction().orders.len(), MAX_ORDERS);
        assert_eq!(
            Auction::SPACE,
            8 + Auction::HEADER_SPACE + 4 + MAX_ORDERS * Order::SPACE
        );
    }

    #[test]
    fn no_cross_closes_without_a_clearing_price_and_refunds_both_sides() {
        let mut auction = new_auction();
        add_order(&mut auction, SIDE_BUY, 120, 100);
        add_order(&mut auction, SIDE_SELL, 180, 100);
        apply_close(&mut auction);
        assert_eq!(auction.state, AUCTION_CLOSED);
        assert_eq!(auction.matched_base, 0);
        assert_eq!(auction.clearing_price_cents, 0);
        assert_eq!(
            claim_amounts(&auction.orders[0], auction.state, 0),
            Some((0, 1_200_000))
        );
        assert_eq!(
            claim_amounts(&auction.orders[1], auction.state, 0),
            Some((100, 0))
        );
    }

    #[test]
    fn price_ties_use_reference_then_lower_tick() {
        let mut auction = new_auction();
        add_order(&mut auction, SIDE_BUY, 160, 100);
        add_order(&mut auction, SIDE_SELL, 140, 100);
        assert_eq!(select_candidate(&auction).unwrap().price_cents, 150);
        auction.opening_reference_cents = 149;
        assert_eq!(select_candidate(&auction).unwrap().price_cents, 149);

        let low = Candidate {
            price_cents: 149,
            matched_base_units: 100,
            imbalance: 0,
            distance_from_reference: 1,
        };
        let high = Candidate {
            price_cents: 151,
            ..low
        };
        assert!(candidate_is_better(low, high));
        assert!(!candidate_is_better(high, low));
        let balanced = Candidate {
            imbalance: 1,
            distance_from_reference: 2,
            ..low
        };
        assert!(candidate_is_better(low, balanced));
    }

    #[test]
    fn allocation_prioritizes_price_then_earlier_order() {
        let mut auction = new_auction();
        add_order(&mut auction, SIDE_BUY, 150, 70);
        add_order(&mut auction, SIDE_BUY, 160, 70);
        add_order(&mut auction, SIDE_BUY, 160, 70);
        let fills = allocate_side(&auction, SIDE_BUY, 150, 100).unwrap();
        assert_eq!(fills[0], 0);
        assert_eq!(fills[1], 70);
        assert_eq!(fills[2], 30);
    }

    #[test]
    fn cancellation_returns_full_escrow_and_excludes_order() {
        let mut auction = new_auction();
        add_order(&mut auction, SIDE_BUY, 150, 100);
        add_order(&mut auction, SIDE_SELL, 150, 100);
        assert_eq!(cancel_refund(&auction.orders[0]), Some((0, 1_500_000)));
        assert_eq!(cancel_refund(&auction.orders[1]), Some((100, 0)));
        auction.orders[0].status = ORDER_CANCELLED;
        auction.orders[0].claimed = true;
        assert_eq!(select_candidate(&auction).unwrap().matched_base_units, 0);
        assert_eq!(cancel_refund(&auction.orders[0]), None);
    }

    #[test]
    fn partial_fill_claims_return_output_and_unfilled_escrow() {
        let mut auction = new_auction();
        add_order(&mut auction, SIDE_BUY, 160, 100);
        add_order(&mut auction, SIDE_SELL, 140, 60);
        apply_close(&mut auction);
        assert_eq!(auction.matched_base, 60);
        assert_eq!(auction.clearing_price_cents, 150);
        assert_eq!(
            claim_amounts(&auction.orders[0], AUCTION_CLOSED, 150),
            Some((60, 700_000))
        );
        assert_eq!(
            claim_amounts(&auction.orders[1], AUCTION_CLOSED, 150),
            Some((0, 900_000))
        );
    }

    #[test]
    fn invalid_reference_halts_and_refunds_every_active_order() {
        let mut auction = new_auction();
        add_order(&mut auction, SIDE_BUY, 160, 100);
        add_order(&mut auction, SIDE_SELL, 140, 80);
        auction.opening_reference_cents = 99;
        apply_close(&mut auction);
        assert_eq!(auction.state, AUCTION_HALTED);
        assert_eq!(
            claim_amounts(&auction.orders[0], auction.state, 0),
            Some((0, 1_600_000))
        );
        assert_eq!(
            claim_amounts(&auction.orders[1], auction.state, 0),
            Some((80, 0))
        );
    }

    #[test]
    fn abort_requires_thirty_minutes_and_no_prior_claims() {
        let mut auction = new_auction();
        assert!(!abort_available(&auction, auction.abort_after - 1));
        assert!(abort_available(&auction, auction.abort_after));
        auction.claimed_count = 1;
        assert!(!abort_available(&auction, auction.abort_after));
    }

    #[test]
    fn aborted_auction_refunds_both_sides_in_full() {
        let buyer = Order {
            side: SIDE_BUY,
            status: ORDER_ACTIVE,
            quantity_base_units: 100,
            escrowed_quote: 1_600_000,
            ..Order::default()
        };
        let seller = Order {
            side: SIDE_SELL,
            status: ORDER_ACTIVE,
            quantity_base_units: 100,
            filled_base_units: 100,
            ..Order::default()
        };
        assert_eq!(
            claim_amounts(&buyer, AUCTION_ABORTED, 150),
            Some((0, 1_600_000))
        );
        assert_eq!(claim_amounts(&seller, AUCTION_ABORTED, 150), Some((100, 0)));
    }
}
