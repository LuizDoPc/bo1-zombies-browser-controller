// kbcoop (bo1z co-op, not part of the original game): coop.js writes it into the map's storage on a co-op page and the
// engine stacks it with fs_mods (maps\_modstack.gsc). See _kbcoop.gsc.
register()
{
	maps\_modstack::add( "_zombiemode_ffotd::main_end", maps\kbcoop\_kbcoop::main_end );
}
