#include maps\_utility;
#include common_scripts\utility;
#include maps\_zombiemode_utility;

// Joining a game in progress (bo1z co-op). Retail zombies never let anyone in after the start (the lobby locked), so a
// late joiner went through the normal first spawn: spawned where they stood, the map's origin (0,0,0), outside the
// playable area, "playing" and stuck there; and the round-end respawn only takes spectators. Here a player who connects
// once round 1 has begun spectates the team, as a dead player does, and respawns beside the team when the round ends.
main_end()
{
	level thread watch_start();
	level thread wrap_spawn_client();
	level thread respawn_late_joiners();
}

watch_start()
{
	level waittill( "start_of_round" );
	level.kbcoop_started = true;
}

// maps\_callbackglobal sets level.spawnClient (Callback_PlayerConnect calls it once a player has connected)
wrap_spawn_client()
{
	while ( !IsDefined( level.spawnClient ) )
	{
		wait 0.05;
	}
	level.kbcoop_spawn_client = level.spawnClient;
	level.spawnClient = ::spawn_client;
}

spawn_client()
{
	if ( !is_true( level.kbcoop_started ) )
	{
		self [[ level.kbcoop_spawn_client ]]();
		return;
	}
	self endon( "disconnect" );
	// the round-end respawn puts them here when no spot near the team is free (maps\_zombiemode::spectator_respawn)
	structs = getstructarray( "initial_spawn_points", "targetname" );
	if ( structs.size > 0 )
	{
		spot = structs[ self GetEntityNumber() % structs.size ];
		self.spectator_respawn = spot;
		self SetOrigin( spot.origin );
		self SetPlayerAngles( spot.angles );
	}
	self.kbcoop_late = true;
	self thread unfreeze_after_spawn();
	self maps\_zombiemode::spawnSpectator();
}

// maps\_zombiemode::onPlayerConnect froze them on connect and its "spawned_player" handler unfreezes, but on this
// respawn the freeze came back right after (they respawned unable to move); unfreeze once more a moment later
unfreeze_after_spawn()
{
	self endon( "disconnect" );
	self waittill( "spawned_player" );
	wait 0.5;
	self FreezeControls( false );
}

// The retail round-end respawn (maps\_zombiemode::spectators_respawn) only runs when the round began with more than one
// player, so a joiner of a game started alone would wait a round more: respawn late joiners here too, the same way.
respawn_late_joiners()
{
	for ( ;; )
	{
		level waittill( "end_of_round" );
		level thread respawn_between_rounds();
	}
}

respawn_between_rounds()
{
	level endon( "between_round_over" );
	wait 1.5;  // the retail respawn goes first when it runs
	for ( ;; )
	{
		players = get_players();
		for ( i = 0; i < players.size; i++ )
		{
			if ( is_true( players[i].kbcoop_late ) && players[i].sessionstate == "spectator" )
			{
				players[i].kbcoop_late = undefined;
				if ( !IsDefined( level.custom_spawnPlayer ) )
				{
					level.custom_spawnPlayer = maps\_zombiemode::spectator_respawn;
				}
				players[i] thread [[ level.spawnPlayer ]]();
			}
		}
		wait 1;
	}
}
